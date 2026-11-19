mod batch;
mod bridge;
mod files;
mod fonts;
mod git;
mod mcassets;
mod mcp;
mod projects;
#[cfg(test)]
mod testing;
mod tools;
mod workspace;
mod workspace_tools;
mod github;

use std::sync::Arc;

use bridge::Bridge;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .manage(mcassets::McAssetsState::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.manage(workspace::init(&app.path().app_config_dir()?));
      let token = mcp::load_or_create_token(&app.path().app_config_dir()?.join("mcp-token"))?;
      let bridge = Arc::new(Bridge::new(app.handle().clone(), token.clone()));
      app.manage(bridge.clone());
      mcp::start(bridge, token);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      bridge::mcp_register_commands,
      bridge::mcp_respond,
      bridge::mcp_status,
      files::read_text_file,
      files::read_java_model_file,
      files::read_binary_file,
      files::write_text_file,
      files::write_binary_file,
      files::write_obj_export,
      fonts::fonts_list,
      fonts::fonts_outline,
      workspace::project_list,
      workspace::project_add,
      workspace::project_remove,
      workspace::project_rename,
      workspace::project_list_dir,
      workspace::project_read_text,
      workspace::project_read_binary,
      workspace::project_write_text,
      workspace::project_write_binary,
      workspace::project_create_dir,
      workspace::project_move,
      workspace::project_trash,
      workspace::project_reveal,
      workspace::git_status,
      workspace::git_branches,
      workspace::git_switch_branch,
      workspace::git_commit,
      workspace::git_pull,
      workspace::git_push,
      workspace::github_account,
      workspace::github_set_client_id,
      workspace::github_login_start,
      workspace::github_login_wait,
      workspace::github_login_token,
      workspace::github_login_cancel,
      workspace::github_logout,
      workspace::github_repos,
      workspace::github_owners,
      workspace::github_create_repo,
      workspace::github_clone,
      mcassets::mc_assets_detect,
      mcassets::mc_assets_open,
      mcassets::mc_assets_close,
      mcassets::mc_assets_info,
      mcassets::mc_assets_read,
      mcassets::mc_assets_list,
      mcassets::mc_assets_read_skin,
    ])
    .run(tauri::generate_context!())
    .expect("error while running Tessel");
}
