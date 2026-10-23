import { Toolbar } from "../../components/ui/Toolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";
import {
  HOME_LIST_MODE_LABELS,
  HOME_LIST_MODES,
  HOME_THREAD_GROUPING_LABELS,
  HOME_THREAD_GROUPINGS,
} from "./homeListMode";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

/** WorkspaceToolbar owns search; these list controls use the leading toolbar. */
export function HomeHeader(props: HomeHeaderProps) {
  return (
    <Toolbar placement="left">
      <Toolbar.Menu
        accessibilityLabel="Thread list options"
        icon="line.3.horizontal.decrease.circle"
        title="Thread list options"
      >
        <Toolbar.Menu title="View">
          <Toolbar.Label>View</Toolbar.Label>
          {HOME_LIST_MODES.map((mode) => (
            <Toolbar.MenuAction
              key={mode}
              isOn={props.listMode === mode}
              onPress={() => props.onListModeChange(mode)}
            >
              <Toolbar.Label>{HOME_LIST_MODE_LABELS[mode]}</Toolbar.Label>
            </Toolbar.MenuAction>
          ))}
        </Toolbar.Menu>
        {props.listMode === "threads" ? (
          <>
            <Toolbar.Menu title="Group threads">
              <Toolbar.Label>Group threads</Toolbar.Label>
              {HOME_THREAD_GROUPINGS.map((grouping) => (
                <Toolbar.MenuAction
                  key={grouping}
                  isOn={props.threadGrouping === grouping}
                  onPress={() => props.onThreadGroupingChange(grouping)}
                >
                  <Toolbar.Label>{HOME_THREAD_GROUPING_LABELS[grouping]}</Toolbar.Label>
                </Toolbar.MenuAction>
              ))}
            </Toolbar.Menu>
            <Toolbar.MenuAction
              isOn={props.hideSettledThreads}
              onPress={() => props.onHideSettledThreadsChange(!props.hideSettledThreads)}
              subtitle="Move settled threads out of the main list"
            >
              <Toolbar.Label>Hide settled</Toolbar.Label>
            </Toolbar.MenuAction>
          </>
        ) : null}
      </Toolbar.Menu>
    </Toolbar>
  );
}
