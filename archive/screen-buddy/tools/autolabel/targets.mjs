// Click targets we can find in Photopea's own page structure, with the words a
// first-time user would get. Ground truth comes from the element's real on-screen box.
//
// locate:
//   { title: "Magic Wand" }   element whose title attribute starts with this text
//   { menu: "Select" }        a top menu-bar button with exactly this text
//   { menuItem: "Inverse" }   a row in an open menu whose label has exactly this text
// state: which screen state the target is visible in (see STATES in autolabel.mjs)

export const TARGETS = [
  { id: "pick-move-tool", state: "default", locate: { title: "Move Tool" },
    goal: "Choose the Move tool so you can drag the layer around.", hint: "An arrow with a small cross, at the top of the left toolbar" },
  { id: "pick-rect-select", state: "default", locate: { title: "Rectangle Select" },
    goal: "Choose the Rectangle Select tool.", hint: "A dotted rectangle icon in the left toolbar" },
  { id: "pick-lasso", state: "default", locate: { title: "Lasso Select" },
    goal: "Choose the Lasso tool to draw a selection by hand.", hint: "A loop of rope icon in the left toolbar" },
  { id: "pick-magic-wand", state: "default", locate: { title: "Magic Wand" },
    goal: "Choose the Magic Wand tool so you can select the background by clicking it.", hint: "A wand with a sparkle in the left toolbar" },
  { id: "pick-crop", state: "default", locate: { title: "Crop Tool" },
    goal: "Choose the Crop tool.", hint: "Two overlapping right angles in the left toolbar" },
  { id: "pick-eraser", state: "default", locate: { title: "Eraser Tool" },
    goal: "Choose the Eraser tool.", hint: "An eraser icon in the left toolbar" },
  { id: "pick-brush", state: "default", locate: { title: "Brush Tool" },
    goal: "Choose the Brush tool.", hint: "A paintbrush icon in the left toolbar" },
  { id: "pick-type", state: "default", locate: { title: "Type Tool" },
    goal: "Choose the Type tool to add text.", hint: "A capital T in the left toolbar" },
  { id: "pick-zoom", state: "default", locate: { title: "Zoom Tool" },
    goal: "Choose the Zoom tool.", hint: "A magnifying glass near the bottom of the left toolbar" },
  { id: "new-layer", state: "default", locate: { title: "New Layer" },
    goal: "Add a new empty layer.", hint: "A small page icon at the bottom of the Layers panel, on the right" },
  { id: "add-mask", state: "default", locate: { title: "Add Raster Mask" },
    goal: "Add a mask to the current layer.", hint: "A rectangle with a circle inside, at the bottom of the Layers panel" },
  { id: "delete-layer", state: "default", locate: { title: "Delete" },
    goal: "Delete the selected layer.", hint: "A bin icon at the bottom right of the Layers panel" },
  { id: "layers-tab", state: "default", locate: { title: "Layers" },
    goal: "Open the Layers panel.", hint: "The tab labelled Layers in the right-hand panels" },
  { id: "menu-select", state: "default", locate: { menu: "Select" },
    goal: "Open the Select menu.", hint: "The word Select in the menu bar at the top" },
  { id: "menu-file", state: "default", locate: { menu: "File" },
    goal: "Open the File menu so you can export your picture.", hint: "The word File at the top left" },
  { id: "menu-layer", state: "default", locate: { menu: "Layer" },
    goal: "Open the Layer menu.", hint: "The word Layer in the menu bar at the top" },
  { id: "select-inverse", state: "menu-select", locate: { menuItem: "Inverse" },
    goal: "Swap the selection so the background is selected instead of the subject.", hint: "Inverse, in the open Select menu" },
  { id: "select-all", state: "menu-select", locate: { menuItem: "All" },
    goal: "Select the whole picture.", hint: "All, at the top of the open Select menu" },
  { id: "select-subject", state: "menu-select", locate: { menuItem: "Subject" },
    goal: "Let the editor select the person automatically.", hint: "Subject, in the open Select menu" },
  { id: "file-export", state: "menu-file", locate: { menuItem: "Export as" },
    goal: "Export your picture as a PNG file.", hint: "Export as, in the open File menu" },
];
