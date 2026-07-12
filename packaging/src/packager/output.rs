use std::path::PathBuf;

use serde::Serialize;

use super::target::HostPlatform;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactKind {
    WebDeployment,
    DesktopInstaller,
    ServiceDeployment,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseArtifact {
    pub kind: ArtifactKind,
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct ReleaseManifest {
    pub schema: u32,
    pub product: String,
    pub version: String,
    pub platform: HostPlatform,
    pub architecture: String,
    pub artifacts: Vec<ReleaseArtifact>,
}

#[derive(Debug)]
pub struct PackageOutput {
    pub directory: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: ReleaseManifest,
}
