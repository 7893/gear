import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import AuthView from "./views/AuthView.vue";
import StatusView from "./views/StatusView.vue";
import MembersView from "./views/MembersView.vue";
import DiagnosticsView from "./views/DiagnosticsView.vue";
import RecoveryView from "./views/RecoveryView.vue";
import HomeView from "./views/HomeView.vue";
import InventoryView from "./views/InventoryView.vue";
import AssetCreateView from "./views/AssetCreateView.vue";
import AssetDetailView from "./views/AssetDetailView.vue";
import { initializeAccounts } from "./accounts";
import "./style.css";

async function start() {
  await initializeAccounts();
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: "/", component: HomeView },
      { path: "/account", component: StatusView },
      { path: "/assets", component: InventoryView },
      { path: "/assets/new", component: AssetCreateView },
      { path: "/assets/:id", component: AssetDetailView },
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
void start();
