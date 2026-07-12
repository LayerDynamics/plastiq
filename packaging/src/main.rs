#[path = "builder/include.rs"]
mod builder;
#[path = "bundler/include.rs"]
mod bundler;
#[path = "config/config.rs"]
mod config;
#[path = "packager/include.rs"]
mod packager;

use std::{env, path::PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};

use builder::BuildManager;
use bundler::BundleManager;
use config::{ConfigManager, Target};
use packager::PackageManager;

#[derive(Debug, Parser)]
#[command(
    name = "plastiq-packaging",
    version,
    about = "Build native Plastiq installers and deployment artifacts"
)]
struct Cli {
    #[arg(long, global = true)]
    repo_root: Option<PathBuf>,
    #[arg(long, global = true)]
    config_directory: Option<PathBuf>,
    #[command(subcommand)]
    action: Action,
}

#[derive(Debug, Subcommand)]
enum Action {
    Verify,
    Build {
        #[arg(value_enum, default_value_t = TargetSelection::All)]
        target: TargetSelection,
    },
    Bundle {
        #[arg(value_enum, default_value_t = TargetSelection::All)]
        target: TargetSelection,
    },
    Package {
        #[arg(value_enum, default_value_t = TargetSelection::All)]
        target: TargetSelection,
    },
    All {
        #[arg(value_enum, default_value_t = TargetSelection::All)]
        target: TargetSelection,
    },
    Release,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum TargetSelection {
    Web,
    Desktop,
    Services,
    All,
}

impl TargetSelection {
    fn targets(self) -> Vec<Target> {
        match self {
            Self::Web => vec![Target::Web],
            Self::Desktop => vec![Target::Desktop],
            Self::Services => vec![Target::Services],
            Self::All => Target::ALL.to_vec(),
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let repo_root = match cli.repo_root {
        Some(path) => path
            .canonicalize()
            .with_context(|| format!("repository root does not exist: {}", path.display()))?,
        None => find_repo_root(env::current_dir()?)?,
    };
    let config_directory = cli
        .config_directory
        .unwrap_or_else(|| ConfigManager::default_directory(&repo_root));
    let config = ConfigManager::new(config_directory).load()?;

    match cli.action {
        Action::Verify => println!("configuration verified: {} targets", config.apps.len()),
        Action::Build { target } => run_build(&repo_root, &config, &target.targets())?,
        Action::Bundle { target } => run_bundle(&repo_root, &config, &target.targets())?,
        Action::Package { target } => run_package(&repo_root, &config, &target.targets())?,
        Action::All { target } => {
            let targets = target.targets();
            run_build(&repo_root, &config, &targets)?;
            run_bundle(&repo_root, &config, &targets)?;
            run_package(&repo_root, &config, &targets)?;
        }
        Action::Release => {
            let targets = Target::ALL;
            run_build(&repo_root, &config, &targets)?;
            run_bundle(&repo_root, &config, &targets)?;
            run_package(&repo_root, &config, &targets)?;
        }
    }
    Ok(())
}

fn run_build(
    repo_root: &std::path::Path,
    config: &config::PackagingConfig,
    targets: &[Target],
) -> Result<()> {
    for output in BuildManager::new(repo_root.to_path_buf(), config).run(targets)? {
        println!(
            "built {} with {} command(s); tooling output: {}",
            output.target,
            output.commands.len(),
            output.directory.display()
        );
        for command in output.commands {
            println!("  {}: exit {}", command.name, command.status_code);
        }
    }
    Ok(())
}

fn run_bundle(
    repo_root: &std::path::Path,
    config: &config::PackagingConfig,
    targets: &[Target],
) -> Result<()> {
    for output in BundleManager::new(repo_root.to_path_buf(), config).run(targets)? {
        println!(
            "bundled {}: {} files in {}",
            output.target,
            output.manifest.files.len(),
            output.directory.display()
        );
    }
    Ok(())
}

fn run_package(
    repo_root: &std::path::Path,
    config: &config::PackagingConfig,
    targets: &[Target],
) -> Result<()> {
    let output = PackageManager::new(repo_root.to_path_buf(), config).run(targets)?;
    println!(
        "release: {} artifacts in {}",
        output.manifest.artifacts.len(),
        output.directory.display()
    );
    println!("manifest: {}", output.manifest_path.display());
    Ok(())
}

fn find_repo_root(mut directory: PathBuf) -> Result<PathBuf> {
    loop {
        if directory.join("package.json").is_file() && directory.join("packaging").is_dir() {
            return Ok(directory);
        }
        if !directory.pop() {
            bail!("could not locate the Plastiq repository root");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_target_selection_has_every_target() {
        assert_eq!(TargetSelection::All.targets(), Target::ALL);
    }
}
