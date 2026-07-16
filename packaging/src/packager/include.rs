#[path = "packager.rs"]
pub mod engine;
#[path = "manager.rs"]
pub mod manager;
#[path = "output.rs"]
pub mod output;
#[path = "main.rs"]
pub mod release;
#[path = "target.rs"]
pub mod target;
#[path = "verifier.rs"]
pub mod verifier;

pub use manager::PackageManager;
