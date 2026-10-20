// Replace the host's ~/.gitconfig for every git child the suite spawns.
// GIT_CONFIG_COUNT overrides local repo config too, which breaks fixtures
// that enable commit.gpgSign or commit an executable `.githooks/post-checkout`.
process.env.GIT_CONFIG_GLOBAL = `${import.meta.dirname}/vitest.gitconfig`;
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_CONFIG_COUNT;
