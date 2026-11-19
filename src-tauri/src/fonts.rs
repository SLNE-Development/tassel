//! Fonts installed on this computer, for 3D text (`scene.add_text`, `font.list`; `src/bridge/fonts.ts`).
//!
//! `fontdb` finds the installed font files, `ttf-parser` reads glyph outlines, advances, metrics and
//! pair kerning from them. Nothing is shaped: one character is one glyph, left to right.
//! Font files are parsed defensively: no result of the parser is unwrapped, and a font that cannot be
//! read is an error message (or, while scanning, simply not listed).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use fontdb::{Database, FaceInfo, Stretch, Style};
use serde::Serialize;
use ttf_parser::gpos::{PairAdjustment, PositioningSubtable};
use ttf_parser::{Face, GlyphId, OutlineBuilder, PlatformId, Tag};

/// Longest text `fonts_outline` accepts, in characters (the limit of `scene.add_text`).
pub const MAX_TEXT_CHARS: usize = 500;
/// Longest family name that is looked up at all.
const MAX_FAMILY_CHARS: usize = 200;

/// One available style of a family.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct FontStyle {
  /// `regular`, `bold`, `italic` or `bold-italic` (bold = weight 600 and above).
  pub style: &'static str,
  /// 100 (thin) to 900 (black); 400 is regular, 700 bold.
  pub weight: u16,
  pub italic: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FontFamily {
  pub family: String,
  /// Sorted by weight, upright before italic; never empty.
  pub styles: Vec<FontStyle>,
  pub monospaced: bool,
}

/// One closed contour. `ops` has one letter per segment and `coords` its numbers, in font units, y up:
/// `M` x y (start), `L` x y (line), `Q` cx cy x y (quadratic Bezier), `C` c1x c1y c2x c2y x y (cubic Bezier).
/// The contour is closed by a line back to its start.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Contour {
  pub ops: String,
  pub coords: Vec<f32>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct GlyphOutline {
  /// The character (one Unicode scalar value).
  pub char: String,
  /// Advance width in font units.
  pub advance: f32,
  /// Empty for blank glyphs (space).
  pub contours: Vec<Contour>,
}

/// Added to the advance of `left` when `right` follows it directly; font units, usually negative.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct KernPair {
  pub left: String,
  pub right: String,
  pub value: f32,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontOutline {
  /// The family that was used, spelled as the font names itself.
  pub family: String,
  /// The style that was used; the closest one the family has to what was asked for.
  pub style: FontStyle,
  pub units_per_em: f32,
  /// Height of capital letters: the font's own value (the exact height of its "H" where the two agree), else the height of "H", else 0.7 em.
  pub cap_height: f32,
  pub ascender: f32,
  /// Negative: below the baseline.
  pub descender: f32,
  pub line_gap: f32,
  /// Every different character of the text the font has a glyph for, in the order of first use.
  pub glyphs: Vec<GlyphOutline>,
  /// Characters of the text the font has no glyph for, each once, in the order of first use.
  pub missing: Vec<String>,
  /// The pairs of directly adjacent characters of the text that have kerning.
  pub kerning: Vec<KernPair>,
}

/// The installed fonts; scanned on first use, which can take a moment, and kept.
pub fn database() -> &'static Database {
  static DATABASE: OnceLock<Database> = OnceLock::new();
  DATABASE.get_or_init(|| {
    let mut db = Database::new();
    db.load_system_fonts();
    db
  })
}

fn is_italic(face: &FaceInfo) -> bool {
  face.style != Style::Normal
}

fn style_of(weight: u16, italic: bool) -> FontStyle {
  let style = match (weight >= 600, italic) {
    (false, false) => "regular",
    (true, false) => "bold",
    (false, true) => "italic",
    (true, true) => "bold-italic",
  };
  FontStyle { style, weight, italic }
}

/// The family name a face is listed under: its first name (English where the font has one).
fn primary_family(face: &FaceInfo) -> Option<&str> {
  face.families.first().map(|(name, _)| name.trim()).filter(|name| !name.is_empty())
}

/// All families with their styles, sorted by name without regard to case, each family once.
pub fn list_families(db: &Database) -> Vec<FontFamily> {
  // Key: lower-case name. Value: name as first seen, styles as (italic, weight), all faces monospaced.
  let mut families: BTreeMap<String, (String, BTreeSet<(u16, bool)>, bool)> = BTreeMap::new();
  for face in db.faces() {
    let Some(name) = primary_family(face) else { continue };
    let entry = families
      .entry(name.to_lowercase())
      .or_insert_with(|| (name.to_string(), BTreeSet::new(), true));
    entry.1.insert((face.weight.0, is_italic(face)));
    entry.2 &= face.monospaced;
  }
  families
    .into_values()
    .map(|(family, styles, monospaced)| FontFamily {
      family,
      styles: styles.into_iter().map(|(weight, italic)| style_of(weight, italic)).collect(),
      monospaced,
    })
    .collect()
}

fn edit_distance(a: &str, b: &str) -> usize {
  let b: Vec<char> = b.chars().collect();
  let mut row: Vec<usize> = (0..=b.len()).collect();
  for (i, ca) in a.chars().enumerate() {
    let mut diagonal = row[0];
    row[0] = i + 1;
    for (j, cb) in b.iter().enumerate() {
      let next = (diagonal + usize::from(ca != *cb)).min(row[j] + 1).min(row[j + 1] + 1);
      diagonal = row[j + 1];
      row[j + 1] = next;
    }
  }
  row[b.len()]
}

/// Up to five installed family names that look like `wanted` (lower-case).
fn similar_families(db: &Database, wanted: &str) -> Vec<String> {
  let mut scored: Vec<(usize, String)> = list_families(db)
    .into_iter()
    .filter_map(|f| {
      let name = f.family.to_lowercase();
      let score = if name.contains(wanted) || wanted.contains(name.as_str()) {
        0
      } else {
        edit_distance(&name, wanted)
      };
      // Names that differ in more than half of their letters are no help.
      (score <= wanted.chars().count().max(4) / 2).then_some((score, f.family))
    })
    .collect();
  scored.sort();
  scored.into_iter().take(5).map(|(_, name)| name).collect()
}

/// The face of `family` (any of its names, case does not matter) closest to the wanted style.
fn find_face<'a>(db: &'a Database, family: &str, bold: bool, italic: bool) -> Result<&'a FaceInfo, String> {
  let wanted = family.trim().to_lowercase();
  if wanted.is_empty() || wanted.chars().count() > MAX_FAMILY_CHARS {
    return Err("The font family name is empty or too long".into());
  }
  let target: i32 = if bold { 700 } else { 400 };
  db.faces()
    .filter(|face| face.families.iter().any(|(name, _)| name.trim().to_lowercase() == wanted))
    .min_by_key(|face| {
      let style = if is_italic(face) == italic { 0 } else { 100_000 };
      let stretch = if face.stretch == Stretch::Normal { 0 } else { 10_000 };
      style + stretch + (i32::from(face.weight.0) - target).abs()
    })
    .ok_or_else(|| {
      let shown: String = family.trim().chars().take(60).collect();
      let similar = similar_families(db, &wanted);
      if similar.is_empty() {
        format!("No installed font family is called \"{shown}\". List the installed families with font_list.")
      } else {
        format!(
          "No installed font family is called \"{shown}\". Similar installed families: {}. List all with font_list.",
          similar.join(", ")
        )
      }
    })
}

#[derive(Default)]
struct Collector {
  contours: Vec<Contour>,
}

impl Collector {
  fn push(&mut self, op: char, coords: &[f32]) {
    if let Some(contour) = self.contours.last_mut() {
      contour.ops.push(op);
      contour.coords.extend_from_slice(coords);
    }
  }
}

impl OutlineBuilder for Collector {
  fn move_to(&mut self, x: f32, y: f32) {
    self.contours.push(Contour { ops: "M".into(), coords: vec![x, y] });
  }
  fn line_to(&mut self, x: f32, y: f32) {
    self.push('L', &[x, y]);
  }
  fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
    self.push('Q', &[x1, y1, x, y]);
  }
  fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
    self.push('C', &[x1, y1, x2, y2, x, y]);
  }
  fn close(&mut self) {}
}

/// The glyph of a character, or None if the font has none. Symbol fonts (Wingdings, ...) have no Unicode
/// mapping; they keep the glyph for a typed character at U+F000 + its code in a Windows symbol table.
fn glyph_of(face: &Face, c: char) -> Option<GlyphId> {
  let known = |glyph: &GlyphId| glyph.0 != 0;
  face.glyph_index(c).filter(known).or_else(|| {
    let code = u32::from(c);
    if !(0x20..0x100).contains(&code) {
      return None;
    }
    face
      .tables()
      .cmap?
      .subtables
      .into_iter()
      .filter(|table| table.platform_id == PlatformId::Windows && table.encoding_id == 0)
      .find_map(|table| table.glyph_index(0xF000 + code).filter(known))
  })
}

fn contours_of(face: &Face, glyph: GlyphId) -> Vec<Contour> {
  let mut collector = Collector::default();
  if face.outline_glyph(glyph, &mut collector).is_none() {
    return Vec::new();
  }
  // A contour needs three points to enclose anything; numbers that are not finite cannot be sent as JSON.
  collector.contours.retain(|c| c.ops.len() >= 2 && c.coords.len() >= 4);
  if collector.contours.iter().any(|c| c.coords.iter().any(|v| !v.is_finite())) {
    return Vec::new();
  }
  collector.contours
}

/// Pair kerning: from the GPOS `kern` feature where the font has one (as text engines do), else from the `kern` table.
struct Kerning<'a> {
  face: &'a Face<'a>,
  /// Lookups of the GPOS `kern` feature for Latin (or the default script); empty if there is none.
  lookups: Vec<u16>,
}

impl<'a> Kerning<'a> {
  fn new(face: &'a Face<'a>) -> Self {
    let mut lookups = Vec::new();
    if let Some(gpos) = face.tables().gpos {
      let kern = Tag::from_bytes(b"kern");
      let script = gpos
        .scripts
        .find(Tag::from_bytes(b"latn"))
        .or_else(|| gpos.scripts.find(Tag::from_bytes(b"DFLT")))
        .or_else(|| gpos.scripts.get(0));
      let language = script.and_then(|s| s.default_language.or_else(|| s.languages.get(0)));
      if let Some(language) = language {
        for index in language.feature_indices {
          if let Some(feature) = gpos.features.get(index).filter(|f| f.tag == kern) {
            lookups.extend(feature.lookup_indices);
          }
        }
      }
    }
    Self { face, lookups }
  }

  fn get(&self, left: GlyphId, right: GlyphId) -> f32 {
    if self.lookups.is_empty() { self.kern_table(left, right) } else { self.gpos(left, right) }
  }

  fn gpos(&self, left: GlyphId, right: GlyphId) -> f32 {
    let Some(gpos) = self.face.tables().gpos else { return 0.0 };
    let mut total = 0.0;
    for &index in &self.lookups {
      let Some(lookup) = gpos.lookups.get(index) else { continue };
      // The first subtable that covers the pair is the one that applies.
      for i in 0..lookup.subtables.len() {
        let Some(PositioningSubtable::Pair(pair)) = lookup.subtables.get::<PositioningSubtable>(i) else { continue };
        let records = match pair {
          PairAdjustment::Format1 { coverage, sets } => {
            coverage.get(left).and_then(|set| sets.get(set)).and_then(|set| set.get(right))
          }
          PairAdjustment::Format2 { coverage, classes, matrix } => {
            if !coverage.contains(left) {
              continue;
            }
            // Covered by this subtable, even if the classes have no adjustment.
            total += matrix.get((classes.0.get(left), classes.1.get(right))).map_or(0.0, |r| f32::from(r.0.x_advance));
            break;
          }
        };
        if let Some(records) = records {
          total += f32::from(records.0.x_advance);
          break;
        }
      }
    }
    total
  }

  fn kern_table(&self, left: GlyphId, right: GlyphId) -> f32 {
    let Some(kern) = self.face.tables().kern else { return 0.0 };
    kern
      .subtables
      .into_iter()
      .filter(|t| t.horizontal && !t.variable && !t.has_cross_stream && !t.has_state_machine)
      .filter_map(|t| t.glyphs_kerning(left, right))
      .map(f32::from)
      .sum()
  }
}

/// Outlines, advances, metrics and kerning for the characters of `text`. Line breaks separate lines
/// (no kerning across them) and are not characters of their own.
pub fn outline(db: &Database, family: &str, bold: bool, italic: bool, text: &str) -> Result<FontOutline, String> {
  if text.chars().count() > MAX_TEXT_CHARS {
    return Err(format!("The text is too long: at most {MAX_TEXT_CHARS} characters"));
  }
  let info = find_face(db, family, bold, italic)?;
  let name = primary_family(info).unwrap_or(family).to_string();
  let unreadable = || format!("The font \"{name}\" could not be read");
  db.with_face_data(info.id, |data, index| extract(data, index, info, name.clone(), bold, text))
    .ok_or_else(unreadable)?
    .ok_or_else(unreadable)
}

fn extract(data: &[u8], index: u32, info: &FaceInfo, family: String, bold: bool, text: &str) -> Option<FontOutline> {
  let mut face = Face::parse(data, index).ok()?;
  let units_per_em = f32::from(face.units_per_em());
  if units_per_em <= 0.0 {
    return None;
  }

  // A variable font is installed as one face; its weight axis gives the bold the family has no file for.
  let mut weight = info.weight.0;
  let wght = Tag::from_bytes(b"wght");
  if bold && weight < 600 && face.variation_axes().into_iter().any(|axis| axis.tag == wght && axis.max_value >= 600.0) {
    let value = face.variation_axes().into_iter().find(|axis| axis.tag == wght).map_or(700.0, |axis| axis.max_value.min(700.0));
    if face.set_variation(wght, value).is_some() {
      weight = value as u16;
    }
  }

  // Capital letters are to come out exactly as tall as asked for, so where the height of the flat "H"
  // agrees with the font's own cap height to within 2 %, the measured one is the one to scale by.
  let stated = face.capital_height().map(f32::from).filter(|h| *h > 0.0);
  let measured = glyph_of(&face, 'H')
    .and_then(|h| face.glyph_bounding_box(h))
    .map(|b| f32::from(b.y_max))
    .filter(|h| *h > 0.0);
  let cap_height = match (stated, measured) {
    (Some(stated), Some(measured)) if (stated - measured).abs() <= stated * 0.02 => measured,
    (Some(stated), _) => stated,
    (None, Some(measured)) => measured,
    (None, None) => units_per_em * 0.7,
  };

  let mut ids: HashMap<char, GlyphId> = HashMap::new();
  let mut glyphs = Vec::new();
  let mut missing = Vec::new();
  let mut seen = HashSet::new();
  for c in text.chars().filter(|c| !matches!(c, '\n' | '\r')) {
    if !seen.insert(c) {
      continue;
    }
    match glyph_of(&face, c) {
      Some(glyph) => {
        ids.insert(c, glyph);
        glyphs.push(GlyphOutline {
          char: c.to_string(),
          advance: face.glyph_hor_advance(glyph).map_or(0.0, f32::from),
          contours: contours_of(&face, glyph),
        });
      }
      None => missing.push(c.to_string()),
    }
  }

  let kerning_of = Kerning::new(&face);
  let mut kerning = Vec::new();
  let mut pairs = HashSet::new();
  let mut previous: Option<char> = None;
  for c in text.chars() {
    if let (Some(left), Some(l), Some(r)) = (previous, previous.and_then(|p| ids.get(&p)), ids.get(&c))
      && pairs.insert((left, c))
    {
      let value = kerning_of.get(*l, *r);
      if value != 0.0 && value.is_finite() {
        kerning.push(KernPair { left: left.to_string(), right: c.to_string(), value });
      }
    }
    // A line break or a character without a glyph separates its neighbours.
    previous = ids.contains_key(&c).then_some(c);
  }

  Some(FontOutline {
    family,
    style: style_of(weight, is_italic(info)),
    units_per_em,
    cap_height,
    ascender: f32::from(face.ascender()),
    descender: f32::from(face.descender()),
    line_gap: f32::from(face.line_gap()),
    glyphs,
    missing,
    kerning,
  })
}

/// The installed font families with their styles, sorted by name.
#[tauri::command]
pub async fn fonts_list() -> Result<Vec<FontFamily>, String> {
  tauri::async_runtime::spawn_blocking(|| list_families(database()))
    .await
    .map_err(|e| format!("Reading the installed fonts failed: {e}"))
}

/// Glyph outlines, metrics and kerning of an installed font for the characters of `text`.
#[tauri::command]
pub async fn fonts_outline(family: String, bold: Option<bool>, italic: Option<bool>, text: String) -> Result<FontOutline, String> {
  tauri::async_runtime::spawn_blocking(move || {
    outline(database(), &family, bold.unwrap_or(false), italic.unwrap_or(false), &text)
  })
  .await
  .map_err(|e| format!("Reading the font failed: {e}"))?
}

#[cfg(test)]
#[path = "fonts_tests.rs"]
mod tests;
