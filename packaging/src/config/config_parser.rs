use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;

pub fn parse_yaml<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("failed to read configuration {}", path.display()))?;
    serde_yaml::from_str(&contents)
        .with_context(|| format!("failed to parse configuration {}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde::Deserialize;
    use tempfile::tempdir;

    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Example {
        value: u32,
    }

    #[test]
    fn parser_reports_valid_and_invalid_yaml() {
        let directory = tempdir().unwrap();
        let valid = directory.path().join("valid.yml");
        let invalid = directory.path().join("invalid.yml");
        fs::write(&valid, "value: 7\n").unwrap();
        fs::write(&invalid, "value: [\n").unwrap();

        assert_eq!(parse_yaml::<Example>(&valid).unwrap(), Example { value: 7 });
        assert!(parse_yaml::<Example>(&invalid).is_err());
    }
}
