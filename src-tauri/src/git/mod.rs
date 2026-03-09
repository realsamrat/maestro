pub mod error;
pub mod ops;
pub mod runner;

pub use error::GitError;
pub use ops::{BranchInfo, ChangeType, CommitInfo, FileChange, FileChangeStatus, GitUserConfig, RemoteInfo, StatusEntry, WorktreeInfo};
pub use runner::Git;
