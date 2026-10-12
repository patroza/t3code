import { Pressable, ScrollView } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import type { HomeHeaderProps } from "./HomeHeader.types";

export function ThreadListFilters(
  props: Pick<
    HomeHeaderProps,
    | "environments"
    | "projects"
    | "selectedEnvironmentIds"
    | "selectedProjectKey"
    | "onToggleEnvironment"
    | "onClearEnvironments"
    | "onProjectChange"
  >,
) {
  const selectedEnvironment = props.environments.find(
    (environment) =>
      props.selectedEnvironmentIds.length === 1 &&
      environment.environmentId === props.selectedEnvironmentIds[0],
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      <ListFilterMenu
        label={
          selectedEnvironment?.label ??
          (props.selectedEnvironmentIds.length > 0
            ? `${props.selectedEnvironmentIds.length} environments`
            : "All environments")
        }
        accessibilityLabel="Filter threads by environment"
        active={props.selectedEnvironmentIds.length > 0}
        actions={[
          {
            id: "all",
            title: "All environments",
            state: props.selectedEnvironmentIds.length === 0 ? "on" : "off",
          },
          ...props.environments.map((environment) => ({
            id: JSON.stringify(environment.environmentId),
            title: environment.label,
            state: props.selectedEnvironmentIds.includes(environment.environmentId)
              ? ("on" as const)
              : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onClearEnvironments();
          else {
            const environment = props.environments.find(
              (candidate) => JSON.stringify(candidate.environmentId) === id,
            );
            if (environment) props.onToggleEnvironment(environment.environmentId);
          }
        }}
      />
      <ListFilterMenu
        label={selectedProject?.label ?? "All projects"}
        accessibilityLabel="Filter threads by project"
        active={selectedProject !== undefined}
        actions={[
          {
            id: "all",
            title: "All projects",
            state: props.selectedProjectKey === null ? "on" : "off",
          },
          ...props.projects.map((project) => ({
            id: JSON.stringify(project.key),
            title: project.label,
            state: project.key === props.selectedProjectKey ? ("on" as const) : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onProjectChange(null);
          else {
            const project = props.projects.find(
              (candidate) => JSON.stringify(candidate.key) === id,
            );
            if (project) props.onProjectChange(project.key);
          }
        }}
      />
      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset thread filters"
          className="h-8 w-8 items-center justify-center"
          onPress={() => {
            props.onClearEnvironments();
            props.onProjectChange(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
