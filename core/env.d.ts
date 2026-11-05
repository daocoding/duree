declare namespace Cloudflare {
  interface Env {
    WORKSPACE: DurableObjectNamespace<import("./workspace").Workspace>;
    DUREE_WORKSPACE: string;
    DUREE_ISSUE_PREFIX: string;
    DUREE_STATUSES: string;
    DUREE_BOOTSTRAP_TOKEN?: string;
    DUREE_ALLOW_DEV_AUTH?: string;
  }
}
