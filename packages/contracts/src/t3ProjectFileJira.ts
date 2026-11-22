import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const T3_PROJECT_FILE_MAX_JIRA_PROJECTS = 20;
const JIRA_PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/u;

const JiraProjectPrefix = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isPattern(JIRA_PROJECT_PREFIX_PATTERN)),
    SchemaTransformation.trim().pipe(
      SchemaTransformation.composeTransformation(SchemaTransformation.toUpperCase()),
    ),
  ),
).annotate({
  description: "A Jira project key, 2–10 letters or digits, such as SA or CFG.",
});

/** The fork's `jiraProjects` key in t3.json; the upstream struct spreads it in. */
export const T3ProjectFileJiraFields = {
  jiraProjects: Schema.optionalKey(
    Schema.Array(JiraProjectPrefix)
      .annotate({
        description:
          "Jira project keys whose bare PROJ-123 tokens count in Discord and GitHub for this repository. List every key this repo should accept, for example SA and CFG. A pasted Jira link still counts either way. Omit the field and only links count.",
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_JIRA_PROJECTS)),
  ),
};
