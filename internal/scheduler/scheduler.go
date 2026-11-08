// Package scheduler is the Go-owned timer for Task schedules. It only decides
// when a Run should start; the application layer performs the Pi prompt.
package scheduler

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"pi-desk/internal/schedule"
)

var ErrBusy = errors.New("schedule already has an active run")

const (
	DefaultInterval      = 30 * time.Second
	DefaultMaxConcurrent = 3
	DefaultCatchUpJitter = 30 * time.Second
	dueQueryLimit        = 128
)

// Runner starts one scheduled Run. It must return quickly after handing the
// prompt to Pi; the scheduler does not wait for the agent turn to finish.
type Runner interface {
	RunScheduled(ctx context.Context, value schedule.Schedule) (RunResult, error)
}

type RunResult struct {
	ThreadID string
	RunID    string
}

type Options struct {
	Interval      time.Duration
	MaxConcurrent int
	// CatchUpJitter spreads a startup catch-up burst. Zero is useful in tests.
	CatchUpJitter func() time.Duration
	Logf          func(format string, args ...any)
}

type Scheduler struct {
	schedules *schedule.Service
	runner    Runner
	interval  time.Duration
	maxActive int
	jitter    func() time.Duration
	logf      func(format string, args ...any)
	now       func() time.Time

	mu      sync.Mutex
	ctx     context.Context
	queue   []schedule.Schedule
	pending map[string]struct{}
	running map[string]struct{}
	wg      sync.WaitGroup
}

func New(schedules *schedule.Service, runner Runner, options Options) *Scheduler {
	if options.Interval <= 0 {
		options.Interval = DefaultInterval
	}
	if options.MaxConcurrent <= 0 {
		options.MaxConcurrent = DefaultMaxConcurrent
	}
	if options.CatchUpJitter == nil {
		options.CatchUpJitter = func() time.Duration {
			return time.Duration(time.Now().UnixNano() % int64(DefaultCatchUpJitter))
		}
	}
	if options.Logf == nil {
		options.Logf = log.Printf
	}
	return &Scheduler{
		schedules: schedules,
		runner:    runner,
		interval:  options.Interval,
		maxActive: options.MaxConcurrent,
		jitter:    options.CatchUpJitter,
		logf:      options.Logf,
		now:       time.Now,
		pending:   make(map[string]struct{}),
		running:   make(map[string]struct{}),
	}
}

// Run ticks immediately (startup catch-up) and then on the configured interval.
func (scheduler *Scheduler) Run(ctx context.Context) {
	if scheduler == nil || scheduler.schedules == nil || scheduler.runner == nil {
		return
	}
	if _, err := scheduler.Tick(ctx, scheduler.now(), true); err != nil {
		scheduler.logf("scheduler: startup tick: %v", err)
	}
	ticker := time.NewTicker(scheduler.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := scheduler.Tick(ctx, scheduler.now(), false); err != nil {
				scheduler.logf("scheduler: tick: %v", err)
			}
		}
	}
}

// Tick advances every due schedule and enqueues it. It returns the number of
// due schedules it observed; actual starts are bounded by MaxConcurrent.
func (scheduler *Scheduler) Tick(ctx context.Context, now time.Time, startup bool) (int, error) {
	scheduler.mu.Lock()
	scheduler.ctx = ctx
	scheduler.mu.Unlock()
	due, err := scheduler.schedules.Due(ctx, now, dueQueryLimit)
	if err != nil {
		return 0, err
	}
	enqueued := 0
	for _, value := range due {
		if value.NextRunAt == nil || value.NextRunAt.After(now) {
			continue
		}
		previous := *value.NextRunAt
		next, ok := schedule.Next(value, now)
		if !ok {
			value.NextRunAt = nil
			value.Enabled = false
		} else {
			next = next.UTC()
			value.NextRunAt = &next
		}
		if value.Frequency == schedule.FrequencyOnce {
			value.Enabled = false
		}
		if startup || previous.Before(now.Add(-2*scheduler.interval)) {
			value.LastCatchUpAt = timePointer(now)
			value.LastStatus = schedule.StatusMissed
		}
		if _, updateErr := scheduler.schedules.Update(ctx, value); updateErr != nil {
			scheduler.logf("scheduler: advance %s: %v", value.ID, updateErr)
			continue
		}
		delay := time.Duration(0)
		if startup {
			delay = scheduler.jitter()
		}
		scheduler.enqueue(value, delay)
		enqueued++
	}
	if startup && enqueued > scheduler.maxActive {
		scheduler.logf("scheduler: catch-up has %d due schedule(s); at most %d run at once", enqueued, scheduler.maxActive)
	}
	scheduler.dispatch(ctx)
	return enqueued, nil
}

// Wait blocks until the currently running scheduled turns return. Tests use
// it; production shutdown can ignore it because the application exits.
func (scheduler *Scheduler) Wait() {
	scheduler.wg.Wait()
}

func (scheduler *Scheduler) enqueue(value schedule.Schedule, delay time.Duration) {
	scheduler.mu.Lock()
	if _, exists := scheduler.pending[value.ID]; exists {
		scheduler.mu.Unlock()
		return
	}
	if _, exists := scheduler.running[value.ID]; exists {
		scheduler.mu.Unlock()
		return
	}
	scheduler.pending[value.ID] = struct{}{}
	scheduler.mu.Unlock()

	if delay > 0 {
		time.AfterFunc(delay, func() { scheduler.ready(value) })
		return
	}
	scheduler.ready(value)
}

func (scheduler *Scheduler) ready(value schedule.Schedule) {
	scheduler.mu.Lock()
	delete(scheduler.pending, value.ID)
	scheduler.queue = append(scheduler.queue, value)
	scheduler.mu.Unlock()
	scheduler.dispatch(scheduler.context())
}

func (scheduler *Scheduler) context() context.Context {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if scheduler.ctx == nil {
		return context.Background()
	}
	return scheduler.ctx
}

func (scheduler *Scheduler) dispatch(ctx context.Context) {
	scheduler.mu.Lock()
	for len(scheduler.queue) > 0 && len(scheduler.running) < scheduler.maxActive {
		value := scheduler.queue[0]
		scheduler.queue = scheduler.queue[1:]
		if _, exists := scheduler.running[value.ID]; exists {
			continue
		}
		if _, exists := scheduler.pending[value.ID]; exists {
			continue
		}
		scheduler.running[value.ID] = struct{}{}
		scheduler.wg.Add(1)
		go scheduler.run(ctx, value)
	}
	scheduler.mu.Unlock()
}

func (scheduler *Scheduler) run(ctx context.Context, value schedule.Schedule) {
	defer scheduler.wg.Done()
	started := scheduler.now()
	_, _ = scheduler.schedules.SetRuntime(ctx, value.ID, started, schedule.StatusStarted, value.LastThreadID, "")
	result, err := scheduler.runner.RunScheduled(ctx, value)
	if err != nil {
		status := schedule.StatusFailed
		if errors.Is(err, ErrBusy) {
			status = schedule.StatusSkipped
		}
		_, _ = scheduler.schedules.SetRuntime(ctx, value.ID, started, status, result.ThreadID, err.Error())
		scheduler.logf("scheduler: run %s: %v", value.ID, err)
	} else {
		_, _ = scheduler.schedules.SetRuntime(ctx, value.ID, started, schedule.StatusCompleted, result.ThreadID, "")
	}
	scheduler.mu.Lock()
	delete(scheduler.running, value.ID)
	scheduler.mu.Unlock()
	scheduler.dispatch(ctx)
}

func timePointer(value time.Time) *time.Time {
	normalized := value.UTC()
	return &normalized
}
