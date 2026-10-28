// Where apt downloads inside a workspace container. Not the default /var/cache/apt/archives: the Ubuntu image's
// docker-clean hook deletes every .deb there right after dpkg runs, before they can be saved for offline replay.
export const APT_KEEP_DIR = "/var/cache/apt/paodo-archives";

/** apt-get options that download into APT_KEEP_DIR. */
export const APT_KEEP_ARGS = ["-o", `Dir::Cache::archives=${APT_KEEP_DIR}/`];

/** Run before any apt-get that downloads: apt refuses an archives dir without its partial/ subdir. */
export const APT_KEEP_PREPARE = ["mkdir", "-p", `${APT_KEEP_DIR}/partial`];

/** Fixed string, nothing interpolated: drops the download cache and package lists once an install is done. */
export const APT_CLEANUP_SCRIPT = `apt-get clean; rm -rf /var/lib/apt/lists/* ${APT_KEEP_DIR}`;
