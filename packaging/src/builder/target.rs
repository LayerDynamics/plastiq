use std::path::{Path, PathBuf};

pub fn expand_template(value: &str, repo_root: &Path, build_directory: &Path) -> String {
    value
        .replace("{repo}", &repo_root.to_string_lossy())
        .replace("{build_directory}", &build_directory.to_string_lossy())
}

pub fn resolve_working_directory(repo_root: &Path, configured: &Path) -> PathBuf {
    repo_root.join(configured)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_known_paths() {
        assert_eq!(
            expand_template(
                "{repo}/x:{build_directory}/y",
                Path::new("/repo"),
                Path::new("/repo/build")
            ),
            "/repo/x:/repo/build/y"
        );
    }
}
