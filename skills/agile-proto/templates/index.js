import { html, render } from "htm/preact";
import { createPortal } from "preact/compat";
import { useEffect } from "preact/hooks";
import { LocationProvider, Route, Router, useLocation } from "preact-iso";
import { AppShell } from "./components/app-shell.js";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";
import { ComponentsPage } from "./routes/components.js";
import { DashboardPage } from "./routes/dashboard.js";
import { HomePage } from "./routes/home.js";
import { MusicPage } from "./routes/music.js";
import { SettingsPage } from "./routes/settings.js";
import { TasksPage } from "./routes/tasks.js";

const BASE = new URL(document.baseURI).pathname.replace(/\/$/, "");
const ROOT_PATH = `${BASE}/` || "/";

function withBase(path) {
  const localPath = path.startsWith("/") ? path : `/${path}`;
  return `${BASE}${localPath}` || "/";
}

function normalizePath(path = "/") {
  const normalized = path.replace(/\/$/, "");
  return normalized || "/";
}

// Scenes — one per file in routes/. Each scene defines the preact-iso path,
// active sidebar URL, and optional pageLabel/breadcrumbs/actions.

function DashboardActions() {
  return html`
    <${Button} size="sm">
      <${Icon} icon="lucide:plus" size=${14} />
      New item
    <//>
  `;
}

const SCENES = [
  {
    id: "dashboard",
    path: withBase("/dashboard"),
    label: "Dashboard",
    Component: DashboardPage,
    pageLabel: "Dashboard",
    actions: DashboardActions(),
  },
  {
    id: "home",
    path: withBase("/home"),
    label: "Home",
    Component: HomePage,
    pageLabel: "Home",
  },
  {
    id: "tasks",
    path: withBase("/tasks"),
    label: "Tasks (data table demo)",
    Component: TasksPage,
    pageLabel: "Tasks",
  },
  {
    id: "music",
    path: withBase("/music"),
    label: "Music (rich layout demo)",
    Component: MusicPage,
    pageLabel: "Music",
  },
  {
    id: "settings",
    path: withBase("/settings"),
    label: "Settings",
    Component: SettingsPage,
    pageLabel: "Settings",
  },
  {
    id: "components",
    path: withBase("/components"),
    label: "Components reference",
    Component: ComponentsPage,
    pageLabel: "Components",
  },
];

const headerEl = document.querySelector("z-proto-header");

function getSceneFromPath(path) {
  const normalized = normalizePath(path);
  if (normalized === normalizePath(ROOT_PATH)) return SCENES[0];
  return SCENES.find((scene) => normalizePath(scene.path) === normalized) || SCENES[0];
}

function getSceneFromUrlHints() {
  const routeParam = new URLSearchParams(window.location.search).get("route");
  if (routeParam) {
    const scene = SCENES.find((item) => item.id === routeParam);
    if (scene) return scene;
  }

  const legacyHashRoute = window.location.hash
    .replace(/^#/, "")
    .split("&")[0]
    .split("?")[0];

  if (legacyHashRoute && legacyHashRoute !== "figmacapture" && !legacyHashRoute.startsWith("figmacapture=")) {
    return SCENES.find((item) => item.id === legacyHashRoute);
  }

  return null;
}

function CaptureRouteBridge() {
  const { path, route } = useLocation();

  useEffect(() => {
    const hintedScene = getSceneFromUrlHints();
    if (!hintedScene) return;
    if (normalizePath(path) === normalizePath(hintedScene.path)) return;

    const captureHash = window.location.hash.startsWith("#figmacapture") ? window.location.hash : "";
    route(`${hintedScene.path}${captureHash}`);
  }, [path, route]);

  return null;
}

function SceneNav() {
  const { path, route } = useLocation();
  const current = getSceneFromUrlHints() || getSceneFromPath(path);
  const idx = SCENES.indexOf(current);

  const prev = () => route(SCENES[(idx - 1 + SCENES.length) % SCENES.length].path);
  const next = () => route(SCENES[(idx + 1) % SCENES.length].path);

  return html`
    <div class="flex items-center gap-1">
      <button
        type="button"
        onClick=${prev}
        class="px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground"
        title="Previous scene"
      >←</button>
      <select
        value=${current.path}
        onChange=${(event) => route(event.target.value)}
        class="zp-select"
      >
        ${SCENES.map((scene) => html`<option value=${scene.path}>${scene.label}</option>`)}
      </select>
      <button
        type="button"
        onClick=${next}
        class="px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground"
        title="Next scene"
      >→</button>
    </div>
  `;
}

function SceneFrame({ scene }) {
  const { route } = useLocation();
  const Scene = scene.Component;

  if (scene.noShell) {
    return html`<${Scene} />`;
  }

  return html`
    <${AppShell}
      activeUrl=${scene.path}
      basePath=${BASE}
      onNavigate=${route}
      pageLabel=${scene.pageLabel}
      title=${scene.title}
      description=${scene.description}
      breadcrumbs=${scene.breadcrumbs}
      actions=${scene.actions}
    >
      <${Scene} />
    <//>
  `;
}

function AppRoutes() {
  return html`
    <${Router}>
      <${Route} path=${ROOT_PATH} component=${() => html`<${SceneFrame} scene=${SCENES[0]} />`} />
      ${SCENES.map(
        (scene) => html`
          <${Route}
            key=${scene.id}
            path=${scene.path}
            component=${() => html`<${SceneFrame} scene=${scene} />`}
          />
        `,
      )}
    <//>
  `;
}

function App() {
  return html`
    <${LocationProvider}>
      <${CaptureRouteBridge} />
      ${headerEl && createPortal(html`<${SceneNav} />`, headerEl)}
      <${AppRoutes} />
    <//>
  `;
}

render(html`<${App} />`, document.getElementById("app"));

// Force z-proto to recompute window dimensions after first render.
// Without this, on first render in desktop preset the vcRect is measured
// before flex layout settles (Preact hasn't mounted yet) and content gets
// clipped at the bottom until the user manually switches preset.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const presetSelect = document.querySelector("z-proto [data-ref='preset']");
    if (presetSelect && presetSelect.value === "desktop") {
      presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
});
