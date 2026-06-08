import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import {
  readSessionTabsRemovedDetail,
  readSessionTabsRestoredDetail,
  SESSION_TABS_REMOVED_EVENT,
  SESSION_TABS_RESTORED_EVENT,
} from "./titlebar-session-events"

const remote = "remote" as ServerConnection.Key

describe("titlebar session events", () => {
  test("reads valid removed session tab details", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { server: "remote", directory: "/tmp/project", sessionIDs: ["ses_1", "ses_2", 1] },
        }),
      ),
    ).toEqual({
      server: remote,
      directory: "/tmp/project",
      sessionIDs: ["ses_1", "ses_2"],
    })
  })

  test("ignores invalid removed session tab details", () => {
    expect(readSessionTabsRemovedDetail(new Event(SESSION_TABS_REMOVED_EVENT))).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: [] },
        }),
      ),
    ).toBeUndefined()
  })

  test("reads valid restored session tab details (same payload shape)", () => {
    expect(
      readSessionTabsRestoredDetail(
        new CustomEvent(SESSION_TABS_RESTORED_EVENT, {
          detail: { server: "remote", directory: "/tmp/project", sessionIDs: ["ses_1"] },
        }),
      ),
    ).toEqual({
      server: remote,
      directory: "/tmp/project",
      sessionIDs: ["ses_1"],
    })
  })

  test("ignores invalid restored session tab details", () => {
    expect(readSessionTabsRestoredDetail(new Event(SESSION_TABS_RESTORED_EVENT))).toBeUndefined()
  })
})
