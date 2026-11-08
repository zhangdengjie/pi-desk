import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore, type TimelineMessage } from "./app";
import { useWorkspaceStore } from "./workspace";

function assistant(): TimelineMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    text: "",
    thinking: "",
    timestamp: "",
    streaming: true,
    tools: [],
  };
}

describe("normalized agent events", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function fixture() {
    const store = useAppStore();
    const workspace = useWorkspaceStore();
    const message = assistant();
    workspace.threads = [{
      id: "thread-1",
      title: "Normalized",
      workspace: "repo",
      workspacePath: "/repo",
      trust: "approve",
      status: "running",
      started: true,
      generation: 1,
    }];
    store.messagesByThread["thread-1"] = [message];
    store.activeAssistantByThread["thread-1"] = message.id;
    return { store, message };
  }

  it("turns tool.started/completed into a tool card when the flag is on", () => {
    const { store, message } = fixture();
    store.useNormalizedEvents = true;
    store.handleAgentEvent({
      id: "event-1", seq: 1, type: "tool.started", threadId: "thread-1",
      ts: 1, payload: { toolCallId: "tool-1", toolName: "bash", args: { command: "ls" } },
    });
    expect(message.tools).toHaveLength(1);
    expect(message.tools[0].status).toBe("running");
    expect(message.tools[0].name).toBe("bash");

    store.handleAgentEvent({
      id: "event-2", seq: 2, type: "tool.completed", threadId: "thread-1",
      ts: 2, payload: { toolCallId: "tool-1", toolName: "bash", result: { output: "file.txt" }, durationMs: 5, isError: false },
    });
    expect(message.tools[0].status).toBe("complete");
    expect(message.tools[0].output).toBe("file.txt");
    expect(message.tools[0].durationMs).toBe(5);
  });

  it("maps tool.failed to an error card", () => {
    const { store, message } = fixture();
    store.useNormalizedEvents = true;
    store.handleAgentEvent({
      id: "event-1", seq: 1, type: "tool.started", threadId: "thread-1",
      ts: 1, payload: { toolCallId: "tool-1", toolName: "bash", args: {} },
    });
    store.handleAgentEvent({
      id: "event-2", seq: 2, type: "tool.failed", threadId: "thread-1",
      ts: 2, payload: { toolCallId: "tool-1", toolName: "bash", result: { output: "boom" } },
    });
    expect(message.tools[0].status).toBe("error");
    expect(message.tools[0].output).toBe("boom");
  });

  it("ignores normalized events while the flag is off", () => {
    const { store, message } = fixture();
    store.handleAgentEvent({
      id: "event-1", seq: 1, type: "tool.started", threadId: "thread-1",
      ts: 1, payload: { toolCallId: "tool-1", toolName: "bash" },
    });
    expect(message.tools).toHaveLength(0);
  });

  it("skips raw pi:event tool frames while normalized mode is on", () => {
    const { store, message } = fixture();
    store.useNormalizedEvents = true;
    store.handlePiEvent({
      threadId: "thread-1",
      event: { type: "tool_execution_start", generation: 1, payload: { toolCallId: "raw-1", toolName: "bash" } },
    });
    expect(message.tools).toHaveLength(0);
  });

  it("applies run.started and run.failed from normalized events", () => {
    const { store, message } = fixture();
    const thread = useWorkspaceStore().threads[0];
    thread.status = "idle";
    store.useNormalizedEvents = true;
    store.handleAgentEvent({
      id: "run-start", seq: 1, type: "run.started", threadId: "thread-1",
      ts: 1, generation: 1, payload: {},
    });
    expect(thread.status).toBe("running");
    store.handleAgentEvent({
      id: "run-failed", seq: 2, type: "run.failed", threadId: "thread-1",
      ts: 2, generation: 1, error: "boom", payload: {},
    });
    expect(thread.status).toBe("attention");
    expect(thread.error).toBe("boom");
    expect(message.tools).toHaveLength(0);
  });

  it("applies message.started/delta/completed", () => {
    const { store } = fixture();
    store.messagesByThread["thread-1"] = [];
    delete store.activeAssistantByThread["thread-1"];
    store.useNormalizedEvents = true;
    store.handleAgentEvent({
      id: "message-start", seq: 1, type: "message.started", threadId: "thread-1",
      ts: 1, payload: { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    });
    expect(store.messagesByThread["thread-1"]).toHaveLength(1);
    expect(store.messagesByThread["thread-1"][0].text).toBe("hi");
    store.handleAgentEvent({
      id: "message-delta", seq: 2, type: "message.delta", threadId: "thread-1",
      ts: 2, payload: { assistantMessageEvent: { type: "text_delta", delta: "!" } },
    });
    expect(store.messagesByThread["thread-1"][0].text).toBe("hi!");
    store.handleAgentEvent({
      id: "message-end", seq: 3, type: "message.completed", threadId: "thread-1",
      ts: 3, payload: { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    });
    expect(store.messagesByThread["thread-1"][0].text).toBe("done");
  });

  it("accepts a JSON-string payload from the Wails event bridge", () => {
    const { store, message } = fixture();
    store.useNormalizedEvents = true;
    store.handleAgentEvent({
      id: "event-1", seq: 1, type: "tool.started", threadId: "thread-1",
      ts: 1, payload: JSON.stringify({ toolCallId: "tool-1", toolName: "bash" }),
    });
    expect(message.tools).toHaveLength(1);
  });
});
