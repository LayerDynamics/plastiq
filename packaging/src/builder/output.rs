use std::path::PathBuf;

use crate::config::Target;

#[derive(Debug)]
pub struct CommandOutput {
    pub name: String,
    pub status_code: i32,
}

#[derive(Debug)]
pub struct BuildOutput {
    pub target: Target,
    pub directory: PathBuf,
    pub commands: Vec<CommandOutput>,
}
