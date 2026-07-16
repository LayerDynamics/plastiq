use std::process::ExitStatus;

use anyhow::{Result, bail};

pub fn verify_exit_status(command_name: &str, status: ExitStatus) -> Result<i32> {
    if !status.success() {
        bail!(
            "build command '{command_name}' failed with status {}",
            status.code().map_or_else(
                || "terminated by signal".to_owned(),
                |code| code.to_string()
            )
        );
    }
    Ok(status.code().unwrap_or_default())
}
