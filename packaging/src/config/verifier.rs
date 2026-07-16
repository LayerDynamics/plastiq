use std::path::{Component, Path};

use anyhow::{Result, bail};

use super::{CONFIG_SCHEMA_VERSION, PackagingConfig, Target};

pub fn verify_config(config: &PackagingConfig) -> Result<()> {
    for target in Target::ALL {
        let app = config.app(target)?;
        if app.schema != CONFIG_SCHEMA_VERSION {
            bail!("{} uses unsupported schema {}", app.name, app.schema);
        }
        if app.name.trim().is_empty() || app.version.trim().is_empty() {
            bail!("target {target} must have a non-empty name and version");
        }
        if app.bundle.is_empty() {
            bail!("target {target} must declare at least one bundle artifact");
        }
        for command in &app.build {
            if command.name.trim().is_empty() || command.program.trim().is_empty() {
                bail!("target {target} contains an unnamed or empty build command");
            }
            verify_relative_path(&command.working_directory, "working directory")?;
        }
        for artifact in &app.bundle {
            verify_relative_path(&artifact.source, "artifact source")?;
            verify_relative_path(&artifact.destination, "artifact destination")?;
        }
    }

    for (name, schema, path) in [
        (
            "builder",
            config.builder.schema,
            config.builder.output_directory.as_path(),
        ),
        (
            "bundler",
            config.bundler.schema,
            config.bundler.output_directory.as_path(),
        ),
        (
            "packager",
            config.packager.schema,
            config.packager.output_directory.as_path(),
        ),
    ] {
        if schema != CONFIG_SCHEMA_VERSION {
            bail!("{name} uses unsupported schema {schema}");
        }
        verify_relative_path(path, &format!("{name} output directory"))?;
        verify_generated_output(path, name)?;
    }
    if config.packager.archive_prefix.trim().is_empty() {
        bail!("packager archive_prefix must not be empty");
    }
    Ok(())
}

fn verify_generated_output(path: &Path, stage: &str) -> Result<()> {
    if !path.starts_with(Path::new("packaging/dist")) || path == Path::new("packaging/dist") {
        bail!(
            "{stage} output directory must be below packaging/dist: {}",
            path.display()
        );
    }
    Ok(())
}

fn verify_relative_path(path: &Path, label: &str) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        bail!(
            "{label} must be a non-empty relative path: {}",
            path.display()
        );
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        bail!("{label} must not escape the repository: {}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_parent_paths() {
        assert!(verify_relative_path(Path::new("/tmp/output"), "test").is_err());
        assert!(verify_relative_path(Path::new("../output"), "test").is_err());
        assert!(verify_relative_path(Path::new("packaging/dist"), "test").is_ok());
    }

    #[test]
    fn generated_outputs_must_stay_below_packaging_dist() {
        assert!(verify_generated_output(Path::new("."), "test").is_err());
        assert!(verify_generated_output(Path::new("packaging/dist"), "test").is_err());
        assert!(verify_generated_output(Path::new("packaging/dist/releases"), "test").is_ok());
    }
}
