mod batch;
mod bridge;
mod files;
mod fonts;
mod mcassets;
mod mcp;
#[cfg(test)]
mod testing;
mod tools;

use std::sync::Arc;

use bridge::Bridge;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(mcassets::McAssetsState::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
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
      files::read_binary_file,
      files::write_text_file,
      files::write_binary_file,
      files::write_obj_export,
      fonts::fonts_list,
      fonts::fonts_outline,
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
