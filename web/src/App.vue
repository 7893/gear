<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import AppIcon from "./components/AppIcon.vue";
import {
  account,
  adminAccess,
  roleLabels,
  statusLabels,
  signOut,
  safeError,
} from "./accounts";
import { inventoryAccess } from "./inventory";
import { flowAccess, flowWriteAccess } from "./flows";
const route = useRoute();
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement>();
const navigation = computed(() =>
  [
    {
      label: "资产与台账",
      items: [
        {
          to: "/assets",
          label: "设备台账",
          icon: "assets",
          show: inventoryAccess.value,
        },
        {
          to: "/due",
          label: "临时使用与到期",
          icon: "clock",
          show: inventoryAccess.value,
        },
        {
          to: "/parties",
          label: "人员与团队",
          icon: "people",
          show: inventoryAccess.value,
        },
      ],
    },
    {
      label: "流转与归档",
      items: [
        {
          to: "/flows",
          label: "流转办理",
          icon: "transfer",
          show: flowWriteAccess.value,
        },
        {
          to: "/documents",
          label: "单据记录",
          icon: "document",
          show: flowAccess.value,
        },
        {
          to: "/documents?evidence=awaiting_upload",
          label: "签字件待办",
          icon: "check",
          show: flowAccess.value,
        },
      ],
    },
    {
      label: "系统与权限",
      items: [
        { to: "/account", label: "我的账号", icon: "account", show: true },
        {
          to: "/members",
          label: "账号管理",
          icon: "people",
          show: adminAccess.value,
        },
        {
          to: "/settings",
          label: "单位设置",
          icon: "settings",
          show: adminAccess.value,
        },
      ],
    },
  ]
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.show),
    }))
    .filter((group) => group.items.length),
);
const primaryNavigation = computed(() =>
  navigation.value.filter((group) => group.label !== "系统与权限"),
);
const systemNavigation = computed(
  () =>
    navigation.value.find((group) => group.label === "系统与权限")?.items ?? [],
);
function activeLink(to: string) {
  const path = route.path;
  if (to.includes("?")) return path === "/documents" && !!route.query.evidence;
  if (to === "/assets")
    return path === "/" ? inventoryAccess.value : path.startsWith("/assets");
  if (to === "/flows")
    return (
      path === "/flows" ||
      path === "/documents/new" ||
      /^\/documents\/[^/]+\/edit$/.test(path)
    );
  if (to === "/documents")
    return (
      path.startsWith("/documents") &&
      !route.query.evidence &&
      path !== "/documents/new" &&
      !path.endsWith("/edit")
    );
  return path === to || path.startsWith(to + "/");
}
const displayName = computed(
  () => account.profile?.membership?.display_name || "我的账号",
);
const roleBadge = computed(() => {
  const membership = account.profile?.membership;
  if (!membership) return "";
  if (membership.status === "active" && membership.role)
    return roleLabels[membership.role];
  return statusLabels[membership.status] || "";
});
function closeMenu(focus = false) {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  if (focus) menuButton.value?.focus();
}
function focusContent() {
  closeMenu();
  const content = document.getElementById("main-content");
  content?.focus({ preventScroll: true });
  content?.scrollIntoView({ block: "start" });
}
watch(
  () => route.fullPath,
  () => closeMenu(),
);
watch(
  () => account.signedIn,
  () => closeMenu(),
);
// Vue owns the bounded, memory-only page cache; never persist private records.
const pageOwner = computed(() =>
  JSON.stringify([
    account.signedIn,
    account.profile?.email,
    account.profile?.membership?.id,
    account.profile?.membership?.status,
    account.profile?.membership?.role,
  ]),
);
async function logout() {
  try {
    await signOut();
  } catch (error) {
    account.error = safeError(error);
  }
}
</script>
<template>
  <div
    class="app-shell"
    :class="{ 'is-signed-in': account.signedIn, 'menu-open': menuOpen }"
  >
    <a class="skip-link" href="#main-content" @click.prevent="focusContent"
      >跳到主要内容</a
    >
    <header class="site-header" @keydown.esc="closeMenu(true)">
      <div class="brand-row">
        <RouterLink to="/" class="brand"
          ><span class="brand-mark"><AppIcon name="assets" /></span>设备簿
          <span class="brand-wordmark">gear</span></RouterLink
        >
        <button
          v-if="account.signedIn"
          ref="menuButton"
          type="button"
          class="quiet menu-toggle"
          :aria-expanded="menuOpen"
          aria-controls="app-navigation"
          @click="menuOpen = !menuOpen"
        >
          <AppIcon :name="menuOpen ? 'close' : 'menu'" />{{
            menuOpen ? "收起导航" : "打开导航"
          }}
        </button>
      </div>

      <nav
        v-if="account.signedIn"
        id="app-navigation"
        class="app-nav"
        aria-label="主导航"
      >
        <div class="nav-links-cluster">
          <div
            v-for="group in primaryNavigation"
            :key="group.label"
            class="nav-group"
          >
            <span class="navigation-caption">{{ group.label }}</span>
            <RouterLink
              v-for="item in group.items"
              :key="item.to"
              :to="item.to"
              :class="{ 'is-current': activeLink(item.to) }"
              :aria-current="activeLink(item.to) ? 'page' : undefined"
              @click="closeMenu()"
              ><AppIcon :name="item.icon" /><span class="nav-label">{{
                item.label
              }}</span></RouterLink
            >
          </div>
        </div>

        <div class="nav-user-cluster">
          <span class="navigation-caption">系统与权限</span>
          <div class="nav-system-links">
            <RouterLink
              v-for="item in systemNavigation"
              :key="item.to"
              :to="item.to"
              :title="item.label"
              :class="{ 'is-current': activeLink(item.to) }"
              :aria-current="activeLink(item.to) ? 'page' : undefined"
              @click="closeMenu()"
              ><AppIcon :name="item.icon" /><span class="nav-label">{{
                item.label
              }}</span></RouterLink
            >
          </div>
          <div class="user-meta-pill">
            <span class="user-avatar" aria-hidden="true">{{
              displayName.slice(0, 1)
            }}</span>
            <span class="user-meta-text">
              <span class="user-name">{{ displayName }}</span>
              <span v-if="roleBadge" class="topbar-role-badge">{{
                roleBadge
              }}</span>
            </span>
          </div>
          <button
            class="quiet sign-out-compact"
            type="button"
            title="退出登录"
            @click="logout"
          >
            <AppIcon name="logout" /><span class="nav-label">退出登录</span>
          </button>
        </div>
      </nav>

      <nav v-else class="guest-nav" aria-label="主导航">
        <RouterLink to="/login">登录</RouterLink
        ><RouterLink class="button quiet" to="/register">注册</RouterLink>
      </nav>
    </header>

    <div class="workspace">
      <main id="main-content" class="page" tabindex="-1">
        <p v-if="account.message" class="notice" role="status">
          {{ account.message }}
        </p>
        <p v-if="account.error" class="notice error" role="alert">
          {{ account.error }}
        </p>
        <p v-if="account.initializing" class="notice" role="status">
          正在连接账号服务…
        </p>
        <p v-else-if="!account.enabled" class="notice">
          账号服务尚未开放，暂不能注册或登录。
        </p>
        <RouterView v-slot="{ Component, route }">
          <KeepAlive
            :key="pageOwner"
            include="HomeView,InventoryView,DueView,PartiesView,DocumentsView"
            :max="6"
          >
            <component
              :is="Component"
              :key="route.meta.retain ? route.path : undefined"
            />
          </KeepAlive>
        </RouterView>
      </main>
    </div>
  </div>
</template>
