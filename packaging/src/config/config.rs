#[path = "config_parser.rs"]
pub mod config_parser;
#[path = "manager.rs"]
pub mod manager;
#[path = "verifier.rs"]
pub mod verifier;

use std::{collections::BTreeMap, fmt, path::PathBuf, str::FromStr};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

pub use manager::ConfigManager;

pub const CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Web,
    Desktop,
    Services,
}

impl Target {
    pub const ALL: [Self; 3] = [Self::Web, Self::Desktop, Self::Services];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Desktop => "desktop",
            Self::Services => "services",
        }
    }
}

impl fmt::Display for Target {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Target {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "web" => Ok(Self::Web),
            "desktop" => Ok(Self::Desktop),
            "services" => Ok(Self::Services),
            _ => bail!("unknown target '{value}'; expected web, desktop, services, or all"),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    pub schema: u32,
    pub name: String,
    pub version: String,
    pub target: Target,
    #[serde(default)]
    pub build: Vec<CommandConfig>,
    pub bundle: Vec<ArtifactConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandConfig {
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_working_directory")]
    pub working_directory: PathBuf,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

fn default_working_directory() -> PathBuf {
    PathBuf::from(".")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactConfig {
    pub source: PathBuf,
    pub destination: PathBuf,
    #[serde(default = "default_true")]
    pub required: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuilderConfig {
    pub schema: u32,
    pub output_directory: PathBuf,
    #[serde(default = "default_true")]
    pub fail_fast: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundlerConfig {
    pub schema: u32,
    pub output_directory: PathBuf,
    #[serde(default)]
    pub exclude_names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackagerConfig {
    pub schema: u32,
    pub output_directory: PathBuf,
    pub archive_prefix: String,
}

#[derive(Debug, Clone)]
pub struct PackagingConfig {
    pub apps: BTreeMap<Target, AppConfig>,
    pub builder: BuilderConfig,
    pub bundler: BundlerConfig,
    pub packager: PackagerConfig,
}

impl PackagingConfig {
    pub fn app(&self, target: Target) -> Result<&AppConfig> {
        self.apps
            .get(&target)
            .ok_or_else(|| anyhow::anyhow!("configuration for target '{target}' is missing"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_parser_accepts_supported_targets() {
        assert_eq!("web".parse::<Target>().unwrap(), Target::Web);
        assert_eq!("desktop".parse::<Target>().unwrap(), Target::Desktop);
        assert_eq!("services".parse::<Target>().unwrap(), Target::Services);
        assert!("mobile".parse::<Target>().is_err());
    }
}
