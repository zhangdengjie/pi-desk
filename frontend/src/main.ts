import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import { startLagRecorder } from "./services/lagRecorder";
import "./styles/workbench.css";
import "./styles/tailwind.css";

document.documentElement.classList.add("overflow-x-clip");
document.body.classList.add("overflow-x-clip");
createApp(App).use(createPinia()).use(i18n).mount("#app");

// The frame recorder is part of the app, not a probe: an intermittent stutter can only be measured
// by a witness that is already running. Records land in `<dataDir>/perf/lag-*.jsonl`; see
// frontend/src/services/lagRecorder.ts and internal/appservice/perflag.go.
startLagRecorder();
