import { createMemo, createSignal } from "solid-js"
import { useTabs, tabKey, type Tab } from "@/context/tabs"
import { useLayout } from "@/context/layout"
import { TitlebarTabStrip } from "./titlebar-tab-strip"

/**
 * A left-hand vertical rail hosting the session/draft tab strip. Rendered by
 * layout-new.tsx when `settings.general.tabOrientation === "vertical"`. The
 * horizontal strip in the titlebar is hidden (`hideTabs`) in that mode, while
 * the titlebar keeps its "new tab" button, so this rail only owns navigation
 * and reordering. Tab state comes from the shared `useTabs()` context, so it
 * stays in sync with the titlebar-driven store.
 */
export function TitlebarTabRail() {
  const tabs = useTabs()
  const tabsStore = tabs.store
  const layout = useLayout()
  const [, setOverflowing] = createSignal(false)

  const currentTab = createMemo(() => {
    const route = layout.route()
    if (route.type === "draft") {
      return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
    }
    if (route.type === "session") {
      return tabsStore.find(
        (item) => item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
      )
    }
  })

  return (
    <div
      data-slot="titlebar-tab-rail"
      class="flex h-full w-56 shrink-0 flex-col overflow-hidden border-r border-v2-border-border-muted bg-v2-background-bg-deep p-2"
    >
      <TitlebarTabStrip
        tabs={tabsStore}
        currentTab={currentTab}
        forceTruncate={false}
        orientation="vertical"
        onOverflowChange={setOverflowing}
        onNavigate={(tab, el) => {
          tabs.select(tab)
          el?.scrollIntoView({ behavior: "instant", block: "nearest" })
        }}
        onClose={(tab) => {
          const index = tabsStore.findIndex((item: Tab) => tabKey(item) === tabKey(tab))
          if (index !== -1) tabs.closeTab(index)
        }}
        onReorder={(keys) => tabs.reorder(keys)}
      />
    </div>
  )
}
