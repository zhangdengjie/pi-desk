package appservice

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"pi-desk/internal/appdirs"
	"pi-desk/internal/domain"
	"pi-desk/internal/userconfig"
)

type fakeProber struct {
	status domain.PiRuntimeStatus
	calls  *int
}

type deadlineProber struct {
	remaining time.Duration
}

func (prober *deadlineProber) Probe(ctx context.Context) domain.PiRuntimeStatus {
	deadline, ok := ctx.Deadline()
	if !ok {
		return domain.PiRuntimeStatus{State: domain.RuntimeError, Message: "missing deadline"}
	}
	prober.remaining = time.Until(deadline)
	return domain.PiRuntimeStatus{State: domain.RuntimeReady}
}

func (prober fakeProber) Probe(context.Context) domain.PiRuntimeStatus {
	if prober.calls != nil {
		(*prober.calls)++
	}
	return prober.status
}

func TestCloseDevToolsWindowRejectsNilParent(t *testing.T) {
	if closeDevToolsWindow(unsafe.Pointer(nil)) {
		t.Fatal("nil parent must not close a window")
	}
}

func TestGetBootstrapState(t *testing.T) {
	calls := 0
	service := NewDesktopService(fakeProber{status: domain.PiRuntimeStatus{
		State:   domain.RuntimeReady,
		Version: "0.84.1",
	}, calls: &calls})

	state := service.GetBootstrapState()

	if state.ProductName != "Pi Desk" || state.Runtime.State != domain.RuntimeChecking || calls != 0 {
		t.Fatalf("unexpected bootstrap state: %#v", state)
	}
}

func TestCheckRuntimeProbesPiAfterBootstrap(t *testing.T) {
	calls := 0
	service := NewDesktopService(fakeProber{status: domain.PiRuntimeStatus{
		State:   domain.RuntimeReady,
		Version: "0.84.1",
	}, calls: &calls})

	status := service.CheckRuntime()

	if status.State != domain.RuntimeReady || status.Version != "0.84.1" || calls != 1 {
		t.Fatalf("unexpected runtime status: %#v (calls=%d)", status, calls)
	}
}

func TestCheckRuntimeAllowsColdWindowsNPMShim(t *testing.T) {
	prober := &deadlineProber{}
	service := NewDesktopService(prober)
	if result := service.CheckRuntime(); result.State != domain.RuntimeReady {
		t.Fatalf("unexpected runtime result: %#v", result)
	}
	if prober.remaining < 7*time.Second || prober.remaining > runtimeProbeTimeout {
		t.Fatalf("unexpected probe budget: %s", prober.remaining)
	}
}

func TestCheckForUpdates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"tag_name":"1.1.0","html_url":"https://example.com/releases/1.1.0","body":"Bug fixes"}`))
	}))
	defer server.Close()
	service := NewDesktopService(fakeProber{}, nil)
	service.updateURL = server.URL
	result := service.CheckForUpdates()
	if result.Status != "available" || result.LatestVersion != "1.1.0" || result.URL == "" {
		t.Fatalf("unexpected available update: %#v", result)
	}

	server.Config.Handler = http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(`{"version":"1.0.3"}`))
	})
	result = service.CheckForUpdates()
	if result.Status != "current" {
		t.Fatalf("expected current version, got %#v", result)
	}
}

func TestCheckForUpdatesRejectsRemoteHTTP(t *testing.T) {
	service := NewDesktopService(fakeProber{}, nil)
	service.updateURL = "http://updates.example.com/latest.json"
	result := service.CheckForUpdates()
	if result.Status != "error" {
		t.Fatalf("expected remote HTTP source rejection, got %#v", result)
	}
}

func TestCheckForUpdatesUsesSemanticVersionOrdering(t *testing.T) {
	manifest := `{"version":"1.0.3-beta.1"}`
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(manifest))
	}))
	defer server.Close()
	service := NewDesktopService(fakeProber{}, nil)
	service.updateURL = server.URL

	if result := service.CheckForUpdates(); result.Status != "current" {
		t.Fatalf("expected an older prerelease to be current, got %#v", result)
	}
	manifest = `{"version":"1.0.4-beta.1"}`
	if result := service.CheckForUpdates(); result.Status != "available" {
		t.Fatalf("expected a newer prerelease to be available, got %#v", result)
	}
	manifest = `{"version":"release-next"}`
	if result := service.CheckForUpdates(); result.Status != "error" {
		t.Fatalf("expected an invalid semantic version error, got %#v", result)
	}
}

func TestGetBootstrapStateCarriesProviderEnvIssues(t *testing.T) {
	service := NewDesktopService(fakeProber{status: domain.PiRuntimeStatus{State: domain.RuntimeReady}})
	SetProviderEnvProbe(service, func() ([]domain.ProviderEnvIssue, error) {
		return []domain.ProviderEnvIssue{{Provider: "bailian", Variable: "DASHSCOPE_API_KEY"}}, nil
	})

	state := service.GetBootstrapState()

	if len(state.ProviderEnvIssues) != 1 || state.ProviderEnvIssues[0].Provider != "bailian" || state.ProviderEnvIssues[0].Variable != "DASHSCOPE_API_KEY" {
		t.Fatalf("bootstrap lost the credential precheck: %#v", state.ProviderEnvIssues)
	}

	// A failing probe is advisory: the bootstrap the whole UI waits on must still come back.
	SetProviderEnvProbe(service, func() ([]domain.ProviderEnvIssue, error) { return nil, errors.New("models.json is unreadable") })
	if issues := service.GetBootstrapState().ProviderEnvIssues; len(issues) != 0 {
		t.Fatalf("a failed probe must report nothing, got %#v", issues)
	}
}

// The config file is the single source of truth for the streaming panel policy, so
// both the dialog and a text editor have to agree on what a read returns.
func TestUserConfigRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv(appdirs.DataDirEnv, "")
	t.Setenv(userconfig.PathEnv, filepath.Join(home, "config.json"))
	service := NewDesktopService(fakeProber{}, nil)

	view := service.ReadUserConfig()
	if view.StreamPanels != userconfig.StreamPanelsAuto {
		t.Fatalf("first read = %q, want %q", view.StreamPanels, userconfig.StreamPanelsAuto)
	}
	if view.Path == "" {
		t.Fatal("the advertised path is empty")
	}
	if _, err := os.Stat(view.Path); err != nil {
		t.Fatalf("a read must create the file it advertises: %v", err)
	}

	// An edit made outside the app is what the next read reports.
	if err := os.WriteFile(view.Path, []byte(`{"streamPanels":"alwaysOpen"}`), 0o600); err != nil {
		t.Fatalf("hand edit: %v", err)
	}
	if got := service.ReadUserConfig(); got.StreamPanels != userconfig.StreamPanelsAlwaysOpen {
		t.Fatalf("after a hand edit = %q", got.StreamPanels)
	}

	updated, err := service.WriteUserConfig(domain.UserConfigView{StreamPanels: userconfig.StreamPanelsAlwaysClosed})
	if err != nil {
		t.Fatalf("WriteUserConfig: %v", err)
	}
	if updated.StreamPanels != userconfig.StreamPanelsAlwaysClosed {
		t.Fatalf("write returned %q", updated.StreamPanels)
	}
	raw, err := os.ReadFile(view.Path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.Contains(string(raw), userconfig.StreamPanelsAlwaysClosed) {
		t.Fatalf("the file does not carry the written value: %s", raw)
	}

	// A typo is refused instead of being stored, and it leaves the file alone.
	if _, err := service.WriteUserConfig(domain.UserConfigView{StreamPanels: "alwaysMaybe"}); err == nil {
		t.Fatal("an unknown mode must be rejected")
	}
	if got := service.ReadUserConfig(); got.StreamPanels != userconfig.StreamPanelsAlwaysClosed {
		t.Fatalf("rejected write changed the file to %q", got.StreamPanels)
	}
}
