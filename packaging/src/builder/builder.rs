use std::{fs, path::PathBuf, process::Command};

use anyhow::{Context, Result};

use crate::config::{AppConfig, BuilderConfig};

use super::{
    output::{BuildOutput, CommandOutput},
    target::{expand_template, resolve_working_directory},
    verifier::verify_exit_status,
};

pub struct Builder<'a> {
    repo_root: PathBuf,
    config: &'a BuilderConfig,
}

impl<'a> Builder<'a> {
    pub fn new(repo_root: PathBuf, config: &'a BuilderConfig) -> Self {
        Self { repo_root, config }
    }

    pub fn build(&self, app: &AppConfig) -> Result<BuildOutput> {
        let output_directory = self.repo_root.join(&self.config.output_directory);
        fs::create_dir_all(&output_directory).with_context(|| {
            format!(
                "failed to create build output directory {}",
                output_directory.display()
            )
        })?;

        let mut commands = Vec::new();
        for configured in &app.build {
            println!("build [{}]: {}", app.target, configured.name);
            let mut command = Command::new(&configured.program);
            command
                .args(
                    configured
                        .args
                        .iter()
                        .map(|arg| expand_template(arg, &self.repo_root, &output_directory)),
                )
                .current_dir(resolve_working_directory(
                    &self.repo_root,
                    &configured.working_directory,
                ));
            for (key, value) in &configured.environment {
                command.env(
                    key,
                    expand_template(value, &self.repo_root, &output_directory),
                );
            }

            let status = command.status().with_context(|| {
                format!(
                    "failed to start '{}' for target {}",
                    configured.program, app.target
                )
            })?;
            match verify_exit_status(&configured.name, status) {
                Ok(status_code) => commands.push(CommandOutput {
                    name: configured.name.clone(),
                    status_code,
                }),
                Err(error) if self.config.fail_fast => return Err(error),
                Err(error) => {
                    eprintln!("{error:#}");
                    commands.push(CommandOutput {
                        name: configured.name.clone(),
                        status_code: status.code().unwrap_or(1),
                    });
                }
            }
        }

        if let Some(failed) = commands.iter().find(|command| command.status_code != 0) {
            anyhow::bail!("build command '{}' failed", failed.name);
        }
        Ok(BuildOutput {
            target: app.target,
            directory: output_directory,
            commands,
        })
    }
}
