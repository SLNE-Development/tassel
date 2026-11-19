//! Tests against the fonts installed on this machine. Windows always has Arial and Segoe UI; on other
//! systems the tests that need a particular family skip themselves.

use super::*;

fn db() -> &'static Database {
  database()
}

fn has(family: &str) -> bool {
  let found = find_face(db(), family, false, false).is_ok();
  if !found {
    eprintln!("skipped: \"{family}\" is not installed");
  }
  found
}

/// Any installed family, for tests that only need some font.
fn any_family() -> String {
  if cfg!(windows) {
    return "Arial".into();
  }
  list_families(db()).first().map(|f| f.family.clone()).unwrap_or_default()
}

fn glyph<'a>(outline: &'a FontOutline, c: &str) -> &'a GlyphOutline {
  outline.glyphs.iter().find(|g| g.char == c).unwrap_or_else(|| panic!("no glyph for {c}"))
}

fn kern(outline: &FontOutline, left: &str, right: &str) -> Option<f32> {
  outline.kerning.iter().find(|k| k.left == left && k.right == right).map(|k| k.value)
}

/// The numbers of a contour must match its segment letters.
fn assert_well_formed(outline: &FontOutline) {
  for g in &outline.glyphs {
    assert_eq!(g.char.chars().count(), 1);
    assert!(g.advance.is_finite() && g.advance >= 0.0);
    for c in &g.contours {
      assert!(c.ops.starts_with('M'), "{:?}", c.ops);
      let expected: usize = c
        .ops
        .chars()
        .map(|op| match op {
          'M' | 'L' => 2,
          'Q' => 4,
          'C' => 6,
          other => panic!("unexpected segment {other}"),
        })
        .sum();
      assert_eq!(c.coords.len(), expected);
      assert_eq!(c.ops.matches('M').count(), 1);
      assert!(c.coords.iter().all(|v| v.is_finite()));
    }
  }
}

#[test]
fn lists_installed_families_sorted_and_unique() {
  let families = list_families(db());
  assert!(!families.is_empty(), "no fonts found on this machine");
  let names: Vec<String> = families.iter().map(|f| f.family.to_lowercase()).collect();
  let mut sorted = names.clone();
  sorted.sort();
  sorted.dedup();
  assert_eq!(names, sorted, "families must be sorted and listed once");
  for f in &families {
    assert!(!f.family.trim().is_empty());
    assert!(!f.styles.is_empty(), "{} has no styles", f.family);
    let mut styles = f.styles.clone();
    styles.dedup();
    assert_eq!(styles.len(), f.styles.len(), "{} lists a style twice", f.family);
  }
  eprintln!("{} families, {} faces", families.len(), db().len());
}

#[cfg(windows)]
#[test]
fn windows_has_arial_and_segoe_ui_with_their_styles() {
  let families = list_families(db());
  let arial = families.iter().find(|f| f.family == "Arial").expect("Arial");
  for style in ["regular", "bold", "italic", "bold-italic"] {
    assert!(arial.styles.iter().any(|s| s.style == style), "Arial {style}");
  }
  assert!(arial.styles.contains(&FontStyle { style: "regular", weight: 400, italic: false }));
  assert!(!arial.monospaced);
  assert!(families.iter().any(|f| f.family == "Segoe UI"));
  let consolas = families.iter().find(|f| f.family == "Consolas");
  assert!(consolas.is_none_or(|f| f.monospaced));
}

#[test]
fn outline_of_a_capital_a() {
  let family = any_family();
  if family.is_empty() {
    return;
  }
  let o = outline(db(), &family, false, false, "A").expect("outline");
  assert_well_formed(&o);
  assert_eq!(o.glyphs.len(), 1);
  assert!(o.missing.is_empty());
  let a = glyph(&o, "A");
  assert!(a.advance > 0.0);
  assert!(!a.contours.is_empty());
  assert!(o.units_per_em >= 16.0);
  assert!(o.cap_height > 0.0 && o.cap_height < o.units_per_em * 1.5);
  assert!(o.ascender > 0.0);
  assert!(o.descender < 0.0);
  assert!(o.line_gap >= 0.0);
  assert_eq!(o.style.style, "regular");
}

#[cfg(windows)]
#[test]
fn arial_metrics_and_holes() {
  let o = outline(db(), "Arial", false, false, "AOBi8").expect("outline");
  assert_well_formed(&o);
  assert_eq!(o.family, "Arial");
  assert_eq!(o.units_per_em, 2048.0);
  // OS/2 says 1467; the flat capitals are 1466 tall.
  assert_eq!(o.cap_height, 1466.0);
  assert_eq!(glyph(&o, "A").contours.len(), 2);
  assert_eq!(glyph(&o, "O").contours.len(), 2);
  assert_eq!(glyph(&o, "B").contours.len(), 3);
  assert_eq!(glyph(&o, "8").contours.len(), 3);
  assert_eq!(glyph(&o, "i").contours.len(), 2);
  // TrueType outlines are quadratic.
  assert!(glyph(&o, "O").contours.iter().all(|c| c.ops.contains('Q') && !c.ops.contains('C')));
}

#[test]
fn o_has_a_hole() {
  let family = any_family();
  if family.is_empty() {
    return;
  }
  let o = outline(db(), &family, false, false, "O").expect("outline");
  assert!(glyph(&o, "O").contours.len() >= 2);
}

#[test]
fn several_characters_each_once_in_order() {
  let family = any_family();
  if family.is_empty() {
    return;
  }
  let o = outline(db(), &family, false, false, "Ag gA").expect("outline");
  assert_well_formed(&o);
  let chars: Vec<&str> = o.glyphs.iter().map(|g| g.char.as_str()).collect();
  assert_eq!(chars, ["A", "g", " "]);
  let space = glyph(&o, " ");
  assert!(space.contours.is_empty() && space.advance > 0.0);
  // "g" reaches below the baseline.
  let lowest = glyph(&o, "g").contours.iter().flat_map(|c| c.coords.chunks(2)).map(|p| p[1]).fold(0.0, f32::min);
  assert!(lowest < 0.0);
}

#[test]
fn unknown_family_is_an_error_with_suggestions() {
  let error = outline(db(), "No Such Font 4711", false, false, "A").unwrap_err();
  assert!(error.contains("No installed font family is called \"No Such Font 4711\""), "{error}");
  assert!(error.contains("font_list"), "{error}");
  assert!(outline(db(), "", false, false, "A").is_err());
  assert!(outline(db(), &"x".repeat(5000), false, false, "A").is_err());
  if has("Arial") {
    let error = outline(db(), "Arail", false, false, "A").unwrap_err();
    assert!(error.contains("Similar installed families:") && error.contains("Arial"), "{error}");
  }
}

#[test]
fn family_names_match_without_regard_to_case() {
  if has("Arial") {
    let o = outline(db(), "  aRiAL ", false, false, "A").expect("outline");
    assert_eq!(o.family, "Arial");
  }
}

#[test]
fn missing_glyphs_are_reported() {
  let family = any_family();
  if family.is_empty() {
    return;
  }
  // U+0378 is not assigned, so no font has it.
  let o = outline(db(), &family, false, false, "A\u{378}B\u{378}").expect("outline");
  assert_eq!(o.missing, ["\u{378}"]);
  let chars: Vec<&str> = o.glyphs.iter().map(|g| g.char.as_str()).collect();
  assert_eq!(chars, ["A", "B"]);
  let none = outline(db(), &family, false, false, "\u{378}").expect("outline");
  assert!(none.glyphs.is_empty());
  assert_eq!(none.missing.len(), 1);
}

#[test]
fn text_length_is_capped_and_line_breaks_are_not_characters() {
  let family = any_family();
  if family.is_empty() {
    return;
  }
  assert!(outline(db(), &family, false, false, &"A".repeat(MAX_TEXT_CHARS)).is_ok());
  let error = outline(db(), &family, false, false, &"A".repeat(MAX_TEXT_CHARS + 1)).unwrap_err();
  assert!(error.contains("at most 500"), "{error}");
  let o = outline(db(), &family, false, false, "A\r\nV\n").expect("outline");
  assert!(o.missing.is_empty());
  assert_eq!(o.glyphs.len(), 2);
  assert!(kern(&o, "A", "V").is_none(), "no kerning across a line break");
  let empty = outline(db(), &family, false, false, "").expect("outline");
  assert!(empty.glyphs.is_empty() && empty.missing.is_empty() && empty.kerning.is_empty());
}

#[test]
fn kerning_from_the_kern_table() {
  // Arial has a `kern` table and no GPOS kerning.
  if !has("Arial") {
    return;
  }
  let o = outline(db(), "Arial", false, false, "AVAV AA").expect("outline");
  let av = kern(&o, "A", "V").expect("AV is kerned in Arial");
  assert!(av < 0.0 && av > -o.units_per_em / 2.0, "{av}");
  assert!(kern(&o, "V", "A").expect("VA") < 0.0);
  assert!(kern(&o, "A", "A").is_none());
  assert_eq!(o.kerning.iter().filter(|k| k.left == "A" && k.right == "V").count(), 1, "each pair once");
  // A character without a glyph separates its neighbours.
  let apart = outline(db(), "Arial", false, false, "A\u{378}V").expect("outline");
  assert!(apart.kerning.is_empty());
}

#[test]
fn kerning_from_gpos() {
  // Segoe UI keeps its kerning in GPOS only.
  if !has("Segoe UI") {
    return;
  }
  let o = outline(db(), "Segoe UI", false, false, "AV To").expect("outline");
  let av = kern(&o, "A", "V").expect("AV is kerned in Segoe UI");
  assert!(av < 0.0 && av > -o.units_per_em / 2.0, "{av}");
  assert!(kern(&o, "T", "o").expect("To") < 0.0);
}

#[test]
fn bold_and_italic_pick_the_matching_face() {
  if !has("Arial") {
    return;
  }
  let regular = outline(db(), "Arial", false, false, "A").expect("regular");
  let bold = outline(db(), "Arial", true, false, "A").expect("bold");
  let italic = outline(db(), "Arial", false, true, "A").expect("italic");
  let both = outline(db(), "Arial", true, true, "A").expect("bold italic");
  assert_eq!(regular.style, FontStyle { style: "regular", weight: 400, italic: false });
  assert_eq!(bold.style, FontStyle { style: "bold", weight: 700, italic: false });
  assert_eq!(italic.style, FontStyle { style: "italic", weight: 400, italic: true });
  assert_eq!(both.style, FontStyle { style: "bold-italic", weight: 700, italic: true });
  assert_ne!(glyph(&regular, "A").advance, glyph(&bold, "A").advance);
  assert_ne!(glyph(&regular, "A").contours, glyph(&italic, "A").contours);
}

#[test]
fn a_family_without_the_style_falls_back_to_the_closest() {
  // Segoe UI Symbol comes in one style only.
  if !has("Segoe UI Symbol") {
    return;
  }
  let o = outline(db(), "Segoe UI Symbol", true, true, "A").expect("outline");
  assert_eq!(o.style.style, "regular");
}

#[test]
fn bold_of_a_variable_font_uses_its_weight_axis() {
  if !has("Bahnschrift") {
    return;
  }
  let regular = outline(db(), "Bahnschrift", false, false, "H").expect("regular");
  let bold = outline(db(), "Bahnschrift", true, false, "H").expect("bold");
  assert_well_formed(&bold);
  if bold.style.weight >= 600 && regular.style.weight < 600 {
    assert_ne!(glyph(&regular, "H").contours, glyph(&bold, "H").contours, "the bold outline is heavier");
  }
}

#[test]
fn symbol_fonts_map_typed_characters() {
  if !has("Wingdings") {
    return;
  }
  let o = outline(db(), "Wingdings", false, false, "A").expect("outline");
  assert!(o.missing.is_empty());
  assert!(!glyph(&o, "A").contours.is_empty());
}

#[test]
fn cubic_outlines_of_cff_fonts() {
  let cff = db().faces().find(|face| {
    db()
      .with_face_data(face.id, |data, index| Face::parse(data, index).is_ok_and(|f| f.tables().cff.is_some()))
      .unwrap_or(false)
  });
  let Some(face) = cff.and_then(primary_family) else {
    eprintln!("skipped: no CFF (OpenType/PostScript) font is installed");
    return;
  };
  let o = outline(db(), face, false, false, "O").expect("outline");
  assert_well_formed(&o);
  if let Some(g) = o.glyphs.first() {
    assert!(g.contours.iter().any(|c| c.ops.contains('C')), "{face}: expected cubic curves");
  }
}

#[test]
fn every_installed_family_can_be_read_without_panicking() {
  let mut failed = 0;
  for family in list_families(db()) {
    for (bold, italic) in [(false, false), (true, true)] {
      match outline(db(), &family.family, bold, italic, "Ag1 \u{e4}\u{20ac}AV") {
        Ok(o) => assert_well_formed(&o),
        Err(error) => {
          failed += 1;
          eprintln!("{}: {error}", family.family);
        }
      }
    }
  }
  eprintln!("{failed} unreadable");
}

#[test]
fn serializes_with_camel_case_keys() {
  let family = any_family();
  if family.is_empty() {
    return;
  }
  let o = outline(db(), &family, false, false, "A").expect("outline");
  let json = serde_json::to_value(&o).expect("json");
  for key in ["family", "style", "unitsPerEm", "capHeight", "ascender", "descender", "lineGap", "glyphs", "missing", "kerning"] {
    assert!(json.get(key).is_some(), "{key}");
  }
  assert!(json["glyphs"][0]["contours"][0]["ops"].is_string());
  assert!(json["glyphs"][0]["contours"][0]["coords"].is_array());
  assert_eq!(json["style"]["style"], "regular");
  let list = serde_json::to_value(list_families(db())).expect("json");
  assert!(list[0]["family"].is_string() && list[0]["styles"][0]["weight"].is_number() && list[0]["monospaced"].is_boolean());
}

/// Writes the outline fixture of the frontend tests (`src/core/mesh/fixtures/arial.json`):
/// `TESSEL_FONT_FIXTURE=<file> cargo test write_frontend_fixture -- --ignored`
#[test]
#[ignore]
fn write_frontend_fixture() {
  let Ok(path) = std::env::var("TESSEL_FONT_FIXTURE") else { return };
  let o = outline(db(), "Arial", false, false, "AVA To Te LT B8iegsl.OH").expect("outline");
  std::fs::write(path, serde_json::to_string(&o).expect("json")).expect("write");
}
