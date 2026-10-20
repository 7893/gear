import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import AuthView from "./views/AuthView.vue";
import StatusView from "./views/StatusView.vue";
import HomeView from "./views/HomeView.vue";
import InventoryView from "./views/InventoryView.vue";
import DueView from "./views/DueView.vue";
import PartiesView from "./views/PartiesView.vue";
import DocumentsView from "./views/DocumentsView.vue";
import { initializeAccounts } from "./accounts";
import "./style.css";

const ScanView = () => import("./views/ScanView.vue");
const MembersView = () => import("./views/MembersView.vue");
const DiagnosticsView = () => import("./views/DiagnosticsView.vue");
const RecoveryView = () => import("./views/RecoveryView.vue");
const InventoryImportView = () => import("./views/InventoryImportView.vue");
const AssetCreateView = () => import("./views/AssetCreateView.vue");
const AssetDetailView = () => import("./views/AssetDetailView.vue");
const PartyDetailView = () => import("./views/PartyDetailView.vue");
const SettingsView = () => import("./views/SettingsView.vue");
const PasswordChangeView = () => import("./views/PasswordChangeView.vue");
const DocumentFormView = () => import("./views/DocumentFormView.vue");
const DocumentDetailView = () => import("./views/DocumentDetailView.vue");

function start() {
  // Callback URL cleanup runs synchronously before routing; network work does not block UI.
  void initializeAccounts();
  const router = createRouter({
    history: createWebHashHistory(),
    scrollBehavior(to, from, savedPosition) {
      if (savedPosition) return savedPosition;
      if (to.path !== from.path) return { top: 0 };
    },
    routes: [
      { path: "/", component: HomeView, meta: { retain: true } },
      { path: "/scan/:kind/:code", component: ScanView },
      { path: "/account", component: StatusView },
      { path: "/account/password", component: PasswordChangeView },
      { path: "/settings", component: SettingsView },
      { path: "/assets", component: InventoryView, meta: { retain: true } },
      { path: "/due", component: DueView, meta: { retain: true } },
      { path: "/assets/import", component: InventoryImportView },
      { path: "/assets/new", component: AssetCreateView },
      { path: "/assets/:id", component: AssetDetailView },
      { path: "/parties", component: PartiesView, meta: { retain: true } },
      { path: "/parties/:id", component: PartyDetailView },
      {
        path: "/flows",
        component: DocumentsView,
        props: { manage: true },
        meta: { retain: true },
      },
      { path: "/documents", component: DocumentsView, meta: { retain: true } },
      { path: "/documents/new", component: DocumentFormView },
      { path: "/documents/:id/edit", component: DocumentFormView },
      { path: "/documents/:id", component: DocumentDetailView },
      { path: "/login", component: AuthView, props: { mode: "login" } },
      { path: "/register", component: AuthView, props: { mode: "register" } },
      { path: "/verify", component: AuthView, props: { mode: "verify" } },
      { path: "/recover", component: RecoveryView },
      { path: "/members", component: MembersView },
      { path: "/diagnostics", component: DiagnosticsView },
      { path: "/:pathMatch(.*)*", redirect: "/" },
    ],
  });
  createApp(App).use(router).mount("#app");
}
start();
