/**
 * A "Local proof" commit status says a trusted machine passed the full agent ship gate on one
 * tree. Fork CI's pull_request runs skip the locally provable jobs only when this matches.
 * Node builtins only: Fork CI runs it before dependencies are installed.
 */

export const LOCAL_PROOF_CONTEXT = "Local proof";
/** Bump when the local gate stops covering what the skipped Fork CI jobs run. */
export const LOCAL_PROOF_VERSION = 1;
const DESCRIPTION_LIMIT = 140;

// A pull_request workflow with a write token posts as github-actions[bot], so that login can
// never vouch for a local run, even when someone lists it.
const NEVER_TRUSTED = new Set(["github-actions[bot]"]);

/**
 * @param {{ tree: string, workflowBlob: string, machine?: string }} proof
 */
export const formatLocalProof = ({ tree, workflowBlob, machine }) => {
  const base = `v${LOCAL_PROOF_VERSION} tree ${tree} workflow ${workflowBlob}`;
  const host = String(machine ?? "")
    .replace(/[^\w.-]+/g, "-")
    .slice(0, DESCRIPTION_LIMIT - base.length - 1);
  return host ? `${base} ${host}` : base;
};

/**
 * @param {string | null | undefined} description
 * @returns {{ version: number, tree: string, workflowBlob: string, machine: string | null } | null}
 */
export const parseLocalProof = (description) => {
  const match = /^v(\d+) tree ([0-9a-f]{40}) workflow ([0-9a-f]{40})(?: (\S+))?$/.exec(
    description ?? "",
  );
  if (!match) return null;
  return {
    version: Number(match[1]),
    tree: match[2],
    workflowBlob: match[3],
    machine: match[4] ?? null,
  };
};

/**
 * The repository owner plus `extra`, the comma separated LOCAL_PROOF_TRUSTED_ACTORS variable.
 * @param {string | null | undefined} owner
 * @param {string | null | undefined} extra
 * @returns {Set<string>} lowercase logins
 */
export const trustedActors = (owner, extra) => {
  const logins = [owner ?? "", ...String(extra ?? "").split(/[\s,]+/)]
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0 && !NEVER_TRUSTED.has(login));
  return new Set(logins);
};

/**
 * @param {string | null | undefined} login
 * @param {Set<string>} trusted
 */
export const isTrustedActor = (login, trusted) =>
  typeof login === "string" && trusted.has(login.toLowerCase());

/**
 * @typedef {{ context?: string, state?: string, description?: string | null, creator?: { login?: string } | null }} CommitStatus
 */

/**
 * Statuses come newest first. Only the newest from a trusted creator counts: a trusted failure
 * revokes a proof, and untrusted statuses never decide either way.
 * @param {{ statuses: ReadonlyArray<CommitStatus>, tree: string, workflowBlob: string, trusted: Set<string> }} input
 * @returns {{ proven: true, proof: NonNullable<ReturnType<typeof parseLocalProof>>, creator: string } | { proven: false, reason: string }}
 */
export const localProofDecision = ({ statuses, tree, workflowBlob, trusted }) => {
  const proofs = statuses.filter((status) => status?.context === LOCAL_PROOF_CONTEXT);
  if (proofs.length === 0) return { proven: false, reason: "no local proof" };
  const latest = proofs.find((status) => isTrustedActor(status.creator?.login, trusted));
  if (!latest) {
    const creators = [...new Set(proofs.map((status) => status.creator?.login ?? "unknown"))];
    return {
      proven: false,
      reason: `local proof only from untrusted ${creators.join(", ")}`,
    };
  }
  if (latest.state !== "success") {
    return { proven: false, reason: `latest local proof is ${latest.state ?? "unknown"}` };
  }
  const proof = parseLocalProof(latest.description);
  if (!proof) return { proven: false, reason: "local proof description is malformed" };
  if (proof.version !== LOCAL_PROOF_VERSION) {
    return {
      proven: false,
      reason: `local proof is format v${proof.version}, this workflow needs v${LOCAL_PROOF_VERSION}`,
    };
  }
  if (proof.tree !== tree) return { proven: false, reason: "local proof is for another tree" };
  if (proof.workflowBlob !== workflowBlob) {
    return { proven: false, reason: "local proof is for another fork-ci.yml" };
  }
  return { proven: true, proof, creator: String(latest.creator?.login) };
};
