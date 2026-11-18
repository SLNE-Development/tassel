// German texts: the source dictionary. `en.ts` has to provide exactly the same keys.
// Texts with parameters are functions; they do their own plurals and number formatting.

const locale = 'de-DE';
const num = (n: number) => n.toLocaleString(locale);

/** `of(n)` is the noun after "von n": "3 von 8 Eckpunkten". */
const elements = {
  vertex: { title: 'Eckpunkte', of: (n: number) => (n === 1 ? 'Eckpunkt' : 'Eckpunkten') },
  edge: { title: 'Kanten', of: (n: number) => (n === 1 ? 'Kante' : 'Kanten') },
  face: { title: 'Flächen', of: (n: number) => (n === 1 ? 'Fläche' : 'Flächen') },
};

export const de = {
  /** BCP 47 tag for number formatting. */
  locale,

  /** Names of keys in shortcut labels. `numpad` is the prefix of the other numpad keys ("Num 1"). */
  keys: {
    Ctrl: 'Strg',
    Shift: 'Umschalt',
    Alt: 'Alt',
    Delete: 'Entf',
    NumpadAdd: 'Num +',
    NumpadSubtract: 'Num −',
    NumpadDecimal: 'Num ,',
    numpad: 'Num ',
  },

  common: {
    name: 'Name',
    close: 'Schließen',
  },

  /** Groups of the command palette. */
  groups: {
    file: 'Datei',
    edit: 'Bearbeiten',
    mode: 'Modus',
    mesh: 'Netz',
    add: 'Hinzufügen',
    view: 'Ansicht',
    tool: 'Werkzeug',
    workspace: 'Arbeitsbereich',
    command: 'Befehl',
  },

  /** Titles of the UI actions: menus, tooltips, command palette. */
  actions: {
    new: 'Neu',
    open: 'Öffnen…',
    save: 'Speichern',
    saveAs: 'Speichern unter…',
    exportGlb: 'Als GLB exportieren',
    exportGltf: 'Als glTF exportieren',
    close: 'Schließen',
    undo: 'Rückgängig',
    redo: 'Wiederholen',
    duplicate: 'Duplizieren',
    delete: 'Löschen',
    selectAll: 'Alles auswählen',
    deselect: 'Auswahl aufheben',
    toggleEditMode: 'Bearbeitungsmodus umschalten',
    objectMode: 'Objektmodus',
    editMode: 'Bearbeitungsmodus',
    elementMode: (element: string) => `Auswahlmodus: ${element}`,
    extrude: 'Extrudieren',
    inset: 'Einsetzen',
    bevel: 'Abschrägen',
    loopCut: 'Schleifenschnitt',
    subdivide: 'Unterteilen',
    merge: 'Verschmelzen',
    mergeCenter: 'Verschmelzen: Mitte',
    mergeFirst: 'Verschmelzen: Erster',
    mergeLast: 'Verschmelzen: Letzter',
    mergeByDistance: 'Verschmelzen: Nach Abstand',
    fill: 'Füllen',
    flipNormals: 'Normalen umkehren',
    selectNone: 'Nichts auswählen',
    selectInvert: 'Auswahl umkehren',
    selectLinked: 'Verbundene auswählen',
    selectMore: 'Auswahl erweitern',
    selectLess: 'Auswahl verkleinern',
    addMenu: 'Hinzufügen',
    addPrimitive: (primitive: string) => `${primitive} hinzufügen`,
    shading: (shading: string) => `Darstellung: ${shading}`,
    cycleShading: 'Darstellung wechseln',
    view: (view: string) => `Ansicht: ${view}`,
    frame: 'Fokussieren',
    tool: (tool: string) => `Werkzeug: ${tool}`,
    workspace: (workspace: string) => `Arbeitsbereich: ${workspace}`,
    palette: 'Befehlspalette',
    preferences: 'Einstellungen…',
  },

  /** Menu bar: menu titles and the shorter item titles used inside labelled groups. */
  menu: {
    file: 'Datei',
    edit: 'Bearbeiten',
    add: 'Hinzufügen',
    mesh: 'Netz',
    view: 'Ansicht',
    export: 'Exportieren',
    exportGlb: 'GLB (binär)',
    exportGltf: 'glTF (JSON)',
    deselect: 'Auswahl aufheben',
    objectMode: 'Objektmodus',
    editMode: 'Bearbeitungsmodus',
    merge: 'Verschmelzen',
    mergeCenter: 'Mitte',
    mergeFirst: 'Erster',
    mergeLast: 'Letzter',
    mergeByDistance: 'Nach Abstand',
    select: 'Auswählen',
    selectAll: 'Alles',
    selectNone: 'Nichts',
    selectInvert: 'Umkehren',
    selectLinked: 'Verbundene',
    selectMore: 'Mehr',
    selectLess: 'Weniger',
    selectMode: 'Auswahlmodus',
    shading: 'Darstellung',
    nextShading: 'Nächste Darstellung',
    viewDirection: 'Blickrichtung',
    palette: 'Befehlspalette…',
  },

  /** Also the default names of new objects. */
  primitives: {
    cube: 'Würfel',
    plane: 'Ebene',
    uv_sphere: 'Kugel',
    ico_sphere: 'Ikosphäre',
    cylinder: 'Zylinder',
    cone: 'Kegel',
    torus: 'Torus',
  },

  tools: {
    select: 'Auswählen',
    move: 'Verschieben',
    rotate: 'Drehen',
    scale: 'Skalieren',
  },

  shadings: {
    solid: 'Solide',
    wireframe: 'Drahtgitter',
    material: 'Material',
  },

  workspaces: {
    modeling: 'Modellieren',
    uv: 'UV',
    paint: 'Malen',
  },

  views: {
    front: 'Vorne',
    back: 'Hinten',
    left: 'Links',
    right: 'Rechts',
    top: 'Oben',
    bottom: 'Unten',
    iso: 'Isometrisch',
  },

  elements,

  app: {
    sidebar: 'Szene und Eigenschaften',
  },

  topBar: {
    workspace: 'Arbeitsbereich',
    documents: 'Dokumente',
    newModel: 'Neues Modell',
    unsaved: ', ungespeichert',
    closeDocument: (name: string) => `${name} schließen`,
    minimize: 'Minimieren',
    maximize: 'Maximieren',
    restore: 'Verkleinern',
  },

  toolRail: {
    tools: 'Werkzeuge',
    tool: 'Werkzeug',
    addObject: 'Objekt hinzufügen',
    shading: 'Darstellung',
    meshTools: 'Netzwerkzeuge',
  },

  viewport: {
    /** "Die Szene ist leer. [Umschalt+A] fügt ein Objekt hinzu, [Strg+K] öffnet alle Befehle." */
    emptyScene: { before: 'Die Szene ist leer. ', between: ' fügt ein Objekt hinzu, ', after: ' öffnet alle Befehle.' },
    upcoming: {
      uv: { phase: 'kommt in Phase 3', text: 'Hier wickelst du Netze ab und ordnest ihre UV-Inseln an.' },
      paint: { phase: 'kommt in Phase 4', text: 'Hier malst du Farbe und Material direkt auf das Modell.' },
    },
    untilThen: 'Bis dahin findest du alles Fertige unter Modellieren.',
  },

  modeSwitch: {
    mode: 'Modus',
    object: 'Objekt',
    edit: 'Bearbeiten',
    objectTip: 'Objekte anordnen',
    editTip: 'Netz des aktiven Objekts bearbeiten',
    selectFirst: 'Wähle zuerst ein Objekt aus',
    selectMode: 'Auswahlmodus',
  },

  outliner: {
    title: 'Szene',
    objects: 'Objekte',
    hide: (name: string) => `${name} ausblenden`,
    show: (name: string) => `${name} einblenden`,
    /** "Noch keine Objekte. Mit [Umschalt+A] fügst du das erste hinzu." */
    empty: { before: 'Noch keine Objekte. Mit ', after: ' fügst du das erste hinzu.' },
  },

  properties: {
    title: 'Eigenschaften',
    activeOf: (selected: number) => `aktives von ${num(selected)} Objekten`,
    selectHint: 'Wähle ein Objekt aus, um Name, Lage und Netzdaten zu sehen.',
    emptyHint: (addKey: string) => `Hier erscheinen Name, Lage und Netzdaten des ausgewählten Objekts. ${addKey} fügt eines hinzu.`,
    position: 'Position',
    rotation: 'Drehung',
    scale: 'Skalierung',
    mesh: 'Netz',
    vertices: 'Eckpunkte',
    edges: 'Kanten',
    faces: 'Flächen',
    triangles: 'Dreiecke',
    withModifiers: 'Mit Modifikatoren',
    selected: 'Ausgewählt',
    /** Between the two numbers of "3 von 8 Eckpunkten". */
    of: ' von ',
    smooth: 'Glätten',
  },

  modifiers: {
    title: 'Modifikatoren',
    add: 'Modifikator hinzufügen',
    addShort: 'Hinzufügen',
    empty: 'Modifikatoren verändern das Netz, ohne es anzutasten: spiegeln, glätten, vervielfachen, verschneiden.',
    names: {
      mirror: 'Spiegeln',
      subdivision: 'Unterteilung',
      array: 'Reihe',
      boolean: 'Boolesch',
    },
    /** Names in the menu that adds a modifier, where there is room for the full name. */
    menuNames: {
      mirror: 'Spiegeln',
      subdivision: 'Unterteilung',
      array: 'Reihe',
      boolean: 'Boolesch',
    },
    enabled: (modifier: string) => `${modifier} aktiv`,
    enable: 'Einschalten',
    disable: 'Ausschalten',
    moveUp: 'Nach oben',
    moveDown: 'Nach unten',
    remove: 'Entfernen',
    apply: 'Anwenden',
    applyTip: 'Ins Netz einrechnen und entfernen',
    applyInEditMode: 'Geht nur im Objektmodus',
    axes: 'Achsen',
    mirrorAxes: 'Spiegelachsen',
    mirrorAcross: (axis: string) => `Spiegeln an ${axis}`,
    mergeDistance: 'Verschmelzabstand',
    levels: 'Stufen',
    count: 'Anzahl',
    offset: 'Versatz',
    operation: 'Operation',
    operations: {
      union: 'Vereinigung',
      difference: 'Differenz',
      intersect: 'Schnitt',
    },
    target: 'Zielobjekt',
    pickTarget: 'Objekt wählen',
    noTarget: 'Kein weiteres Objekt',
  },

  /** The panel with the parameters of the operation that just ran. */
  lastAction: {
    title: 'Letzte Aktion',
    defaultValue: 'Standard',
    /** Names of command parameters, by parameter key. Unknown parameters show their own key. */
    params: {
      distance: 'Abstand',
      thickness: 'Stärke',
      depth: 'Tiefe',
      individual: 'Einzeln',
      width: 'Breite',
      segments: 'Segmente',
      cuts: 'Schnitte',
      at: 'Ziel',
      kind: 'Elemente',
      size: 'Größe',
      radius: 'Radius',
      height: 'Höhe',
      rings: 'Ringe',
      subdivisions: 'Unterteilungen',
      minorRadius: 'Rohrradius',
      minorSegments: 'Rohrsegmente',
      position: 'Position',
      rotation: 'Drehung',
      scale: 'Skalierung',
      translate: 'Verschiebung',
      rotate: 'Drehung',
      pivot: 'Drehpunkt',
      count: 'Anzahl',
      offset: 'Versatz',
      levels: 'Stufen',
      angle: 'Winkel',
      smooth: 'Glätten',
    },
    /** Names of enum values, by value. */
    values: {
      center: 'Mitte',
      first: 'Erster',
      last: 'Letzter',
      vertices: 'Eckpunkte',
      edges: 'Kanten',
      faces: 'Flächen',
    },
  },

  controls: {
    dragToChange: 'Ziehen, um den Wert zu ändern',
    noOptions: 'Keine Auswahl möglich',
  },

  palette: {
    title: 'Befehlspalette',
    search: 'Befehl suchen',
    commands: 'Befehle',
    noMatch: (query: string) => `Kein Befehl passt zu „${query}“.`,
    executed: 'Ausgeführt',
  },

  dialogs: {
    cancel: 'Abbrechen',
    unsavedTitle: 'Änderungen speichern?',
    unsavedText: (name: string) => `„${name}“ hat ungespeicherte Änderungen. Wenn du sie verwirfst, sind sie weg.`,
    discard: 'Verwerfen',
    save: 'Speichern',
    quitTitle: 'Tessel beenden?',
    quitText: (names: readonly string[]) =>
      `${
        names.length === 1
          ? `„${names[0]}“ hat ungespeicherte Änderungen.`
          : `${num(names.length)} Dokumente haben ungespeicherte Änderungen: ${names.join(', ')}.`
      } Beim Beenden gehen sie verloren.`,
    quitWithoutSaving: 'Beenden ohne Speichern',
  },

  toasts: {
    failed: 'Das hat nicht geklappt',
    saved: 'Gespeichert',
    exported: 'Exportiert',
    glbWritten: 'GLB-Datei geschrieben',
    gltfWritten: 'glTF-Datei geschrieben',
    noActiveObject: 'Kein aktives Objekt',
    noActiveObjectHint: 'Wähle ein Objekt aus, um sein Netz zu bearbeiten.',
    nothingSelected: 'Nichts ausgewählt',
    copied: 'In die Zwischenablage kopiert',
  },

  status: {
    objectMode: 'Objektmodus',
    editMode: 'Bearbeitungsmodus',
    nothingSelected: 'Nichts ausgewählt',
    /** After the active object's name: "Würfel und 2 weitere". */
    andMore: (others: number) => ` und ${num(others)} ${others === 1 ? 'weiteres' : 'weitere'}`,
    elementsSelected: (selected: number, total: number, mode: keyof typeof elements) =>
      `${num(selected)} von ${num(total)} ${elements[mode].of(total)} ausgewählt`,
    objects: (n: number) => `${num(n)} ${n === 1 ? 'Objekt' : 'Objekte'}`,
    vertices: (n: number) => `${num(n)} ${n === 1 ? 'Eckpunkt' : 'Eckpunkte'}`,
    faces: (n: number) => `${num(n)} ${n === 1 ? 'Fläche' : 'Flächen'}`,
  },

  mcp: {
    desktopOnly: 'MCP nur in der Desktop-App',
    running: 'läuft',
    error: 'Fehler',
    stopped: 'gestoppt',
    connect: 'KI-Client verbinden',
    notRunning: 'MCP-Server läuft nicht',
    copyClaudeCommand: 'Befehl für Claude Code kopieren',
    copyJson: 'JSON-Konfiguration kopieren',
    copyUrl: 'Adresse kopieren',
    copyToken: 'Zugriffstoken kopieren',
  },
} as const;

/** The shape every language has to fill: the German dictionary with its literal texts widened to `string`. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => unknown
    ? (...args: A) => string
    : { readonly [K in keyof T]: Widen<T[K]> };

export type Dictionary = Widen<typeof de>;
