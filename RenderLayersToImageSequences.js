/*
 * RenderLayersToImageSequences.js
 * Rogier Henkelman Jul 2, 2026
 * 
 * -------------------------------------------------------------------------
 * Renders every ENABLED drawing layer (READ node) to its own image sequence,
 * one folder per layer, then writes sidecar files so an After Effects
 * compositor can rebuild the scene with almost no manual work:
 *
 *   1. Import_<scene>_into_AE.jsx  - self-contained AE ExtendScript. In AE:
 *      File > Scripts > Run Script File... -> pick this file. It creates a comp
 *      at the right size/fps/length, imports each layer, stacks them in the
 *      original Timeline order, and (optionally) groups each Harmony character
 *      group into its own precomp. Can also save a real .aep when done.
 *
 *   2. <scene>_layers.json         - a generic manifest (scene metadata +
 *      ordered layer list, incl. group) for any other tool or pipeline.
 *
 * On .aep automation: a binary .aep can't be written directly (undocumented
 * format), but the .jsx can have AE itself save one via app.project.save().
 * For fully hands-off use, run the importer from the command line:
 *     afterfx.exe -r "<path>/Import_<scene>_into_AE.jsx"
 * (add app.quit() to the .jsx if you want AE to close afterwards.)
 *
 * Because the .jsx controls layer order, the numeric folder prefixes are
 * optional - order is preserved by the script regardless.
 *
 * Skips disabled layers and layers inside disabled groups. Saves with the
 * 4-channel format variant (PNG4, TGA4, ...) so transparency is preserved.
 *
 * Tested against the Harmony 24 scripting API.
 * -------------------------------------------------------------------------
 */

var FORMATS = [
    { label: "PNG  (recommended)", ext: "png", plain: "PNG",   alpha: "PNG4"   },
    { label: "PNG 16-bit",         ext: "png", plain: "PNGDP", alpha: "PNGDP4" },
    { label: "TGA / TARGA",        ext: "tga", plain: "TGA",   alpha: "TGA4"   },
    { label: "PSD (Photoshop)",    ext: "psd", plain: "PSD",   alpha: "PSD4"   },
    { label: "SGI",                ext: "sgi", plain: "SGI",   alpha: "SGI4"   },
    { label: "SGI 16-bit",         ext: "sgi", plain: "SGIDP", alpha: "SGIDP4" },
    { label: "BMP",                ext: "bmp", plain: "BMP",   alpha: "BMP4"   },
    { label: "TIFF",               ext: "tif", plain: "TIF",   alpha: null     },
    { label: "OpenEXR",            ext: "exr", plain: "EXR",   alpha: "EXR"    },
    { label: "JPEG (no alpha)",    ext: "jpg", plain: "JPG",   alpha: null     }
];


function RenderLayersToImageSequences()
{
    if (frame.numberOf() < 1) {
        MessageBox.information("This scene has no frames to render.");
        return;
    }

    var cfg = showSettingsDialog();
    if (!cfg) return;

    if (!ensureDir(cfg.outputRoot)) {
        MessageBox.information("Could not create/access the output folder:\n" + cfg.outputRoot);
        return;
    }

    var layers = getOrderedEnabledReadNodes();
    if (layers.length === 0) {
        MessageBox.information("No enabled drawing layers (READ nodes) were found in this scene.");
        return;
    }

    // Per-layer output info + numbered/de-duplicated folders + manifest records.
    var padWidth  = ("" + layers.length).length;
    var usedNames = {};
    var layerInfo = {};
    var records   = [];
    for (var i = 0; i < layers.length; i++) {
        var path     = layers[i];
        var display  = makeSafeName(node.getName(path));
        var folder   = cfg.numberFolders ? (pad(i + 1, padWidth) + "_" + display) : display;
        folder       = uniqueName(folder, usedNames);   // guarantee unique on disk
        var dirPath  = cfg.outputRoot + "/" + folder;
        if (!ensureDir(dirPath)) MessageLog.trace("WARNING: could not create folder: " + dirPath);

        layerInfo[path] = { dir: dirPath, name: folder, saved: 0 };
        records.push({ display: display, folder: folder, group: getCharacterGroup(path), source: path });
    }

    var frameCount = cfg.endFrame - cfg.startFrame + 1;
    var total      = layers.length * frameCount;
    MessageLog.trace("Rendering " + layers.length + " layer(s), frames "
                     + cfg.startFrame + "-" + cfg.endFrame + " @ "
                     + cfg.resX + "x" + cfg.resY + " -> " + cfg.outputRoot);

    // Progress dialog (updated per frame during the blocking render).
    var progress = new QProgressDialog("Preparing to render\u2026", "", 0, total);
    progress.windowTitle     = "Rendering " + layers.length + " layer(s)";
    progress.modal           = true;
    progress.minimumDuration = 0;
    progress.setCancelButton(null);
    progress.value = 0;
    progress.show();
    pumpUI();

    var done = 0;
    function onNodeFrameReady(f, celImage, nodePath) {
        var info = layerInfo[nodePath];
        if (info) {
            var filePath = info.dir + "/" + info.name + "-" + pad(f, cfg.padding) + "." + cfg.ext;
            saveCel(celImage, filePath, cfg.formatCode);
            info.saved++;
        }
        done++;
        progress.labelText = "Rendering: " + (info ? info.name : nodePath)
                             + "\nframe " + f + "        (" + done + " / " + total + ")";
        progress.value = done;
        pumpUI();
    }

    render.nodeFrameReady.connect(onNodeFrameReady);
    try {
        render.setResolution(cfg.resX, cfg.resY);
        render.setWriteEnabled(false);
        render.renderNodes(layers, cfg.startFrame, cfg.endFrame);
    } finally {
        render.nodeFrameReady.disconnect(onNodeFrameReady);
        progress.close();
        pumpUI();
    }

    // --- Sidecar files --------------------------------------------------
    var sceneName = getSceneName();
    var meta = {
        scene:      sceneName,
        sceneFile:  makeSafeName(sceneName),
        width:      cfg.resX,
        height:     cfg.resY,
        fps:        getFrameRate(),
        start:      cfg.startFrame,
        end:        cfg.endFrame,
        ext:        cfg.ext,
        pad:        cfg.padding,
        premult:    cfg.premult,
        groupAsPrecomps: cfg.groupAsPrecomps,
        saveAep:    cfg.saveAep
    };
    var extras = [];

    if (cfg.writeAE) {
        var jsxPath = cfg.outputRoot + "/Import_" + meta.sceneFile + "_into_AE.jsx";
        if (writeAEImporter(jsxPath, meta, records)) extras.push("AE importer: " + jsxPath);
    }
    if (cfg.writeManifest) {
        var jsonPath = cfg.outputRoot + "/" + meta.sceneFile + "_layers.json";
        if (writeManifest(jsonPath, meta, records)) extras.push("Manifest: " + jsonPath);
    }

    // --- Report ---------------------------------------------------------
    var lines = ["Done. Output in:\n" + cfg.outputRoot + "\n"];
    for (var i2 = 0; i2 < layers.length; i2++) {
        var inf = layerInfo[layers[i2]];
        lines.push("  " + inf.name + ": " + inf.saved + " frame(s)");
    }
    if (extras.length) { lines.push(""); for (var e = 0; e < extras.length; e++) lines.push(extras[e]); }
    var summary = lines.join("\n");
    MessageLog.trace(summary);
    MessageBox.information(summary);
}


/* --------------------------- SETTINGS DIALOG --------------------------- */

function showSettingsDialog()
{
    var dialog = new QDialog();
    dialog.windowTitle = "Render Layers to Image Sequences";
    dialog.minimumWidth = 500;
    var grid = new QGridLayout(dialog);
    var row = 0;

    grid.addWidget(new QLabel("Output folder:"), row, 0);
    var folderEdit = new QLineEdit(dialog);
    folderEdit.text = scene.currentProjectPath() + "/layer_renders";
    grid.addWidget(folderEdit, row, 1);
    var browseBtn = new QPushButton("Browse...", dialog);
    grid.addWidget(browseBtn, row, 2);
    browseBtn.clicked.connect(function () {
        var chosen = QFileDialog.getExistingDirectory(dialog, "Choose the output folder", folderEdit.text);
        if (chosen && chosen.length > 0) folderEdit.text = chosen;
    });
    row++;

    grid.addWidget(new QLabel("Image format:"), row, 0);
    var formatCombo = new QComboBox(dialog);
    for (var i = 0; i < FORMATS.length; i++) formatCombo.addItem(FORMATS[i].label);
    formatCombo.currentIndex = 0;
    grid.addWidget(formatCombo, row, 1, 1, 2);
    row++;

    var alphaCheck = new QCheckBox("Transparency (alpha channel)", dialog);
    alphaCheck.checked = true;
    grid.addWidget(alphaCheck, row, 1, 1, 2);
    row++;

    grid.addWidget(new QLabel("Resolution (W x H):"), row, 0);
    var resW = new QSpinBox(dialog); resW.minimum = 1; resW.maximum = 30000;
    var resH = new QSpinBox(dialog); resH.minimum = 1; resH.maximum = 30000;
    resW.value = scene.defaultResolutionX();
    resH.value = scene.defaultResolutionY();
    var resBox = new QHBoxLayout();
    resBox.addWidget(resW, 0, 0); resBox.addWidget(new QLabel(" x "), 0, 0); resBox.addWidget(resH, 0, 0);
    grid.addLayout(resBox, row, 1, 1, 2);
    row++;

    grid.addWidget(new QLabel("Frame range:"), row, 0);
    var startSpin = new QSpinBox(dialog); startSpin.minimum = 1; startSpin.maximum = 999999;
    var endSpin   = new QSpinBox(dialog); endSpin.minimum = 1;   endSpin.maximum = 999999;
    startSpin.value = 1;
    endSpin.value   = frame.numberOf();
    var rangeBox = new QHBoxLayout();
    rangeBox.addWidget(startSpin, 0, 0); rangeBox.addWidget(new QLabel(" to "), 0, 0); rangeBox.addWidget(endSpin, 0, 0);
    grid.addLayout(rangeBox, row, 1, 1, 2);
    row++;

    var aeCheck = new QCheckBox("Write After Effects import script (.jsx)", dialog);
    aeCheck.checked = true;
    grid.addWidget(aeCheck, row, 1, 1, 2);
    row++;

    var groupCheck = new QCheckBox("Group characters (Harmony groups) into AE precomps", dialog);
    groupCheck.checked = true;
    grid.addWidget(groupCheck, row, 1, 1, 2);
    row++;

    var saveAepCheck = new QCheckBox("Have AE save a .aep after building", dialog);
    saveAepCheck.checked = true;
    grid.addWidget(saveAepCheck, row, 1, 1, 2);
    row++;

    var manifestCheck = new QCheckBox("Write layer manifest (.json)", dialog);
    manifestCheck.checked = true;
    grid.addWidget(manifestCheck, row, 1, 1, 2);
    row++;

    var numberCheck = new QCheckBox("Prefix folders with order number (optional; importer keeps order without it)", dialog);
    numberCheck.checked = false;
    grid.addWidget(numberCheck, row, 1, 1, 2);
    row++;

    var btnBox = new QHBoxLayout();
    var okBtn = new QPushButton("Render", dialog);
    var cancelBtn = new QPushButton("Cancel", dialog);
    btnBox.addStretch(1);
    btnBox.addWidget(cancelBtn, 0, 0);
    btnBox.addWidget(okBtn, 0, 0);
    grid.addLayout(btnBox, row, 0, 1, 3);
    okBtn.clicked.connect(dialog, dialog.accept);
    cancelBtn.clicked.connect(dialog, dialog.reject);

    if (!dialog.exec()) return null;

    var fmt = FORMATS[formatCombo.currentIndex];
    var wantAlpha = alphaCheck.checked && fmt.alpha !== null;
    if (alphaCheck.checked && fmt.alpha === null)
        MessageLog.trace("Note: " + fmt.label + " has no alpha variant; rendering opaque.");

    var start = startSpin.value, end = endSpin.value;
    if (end < start) { var t = start; start = end; end = t; }

    return {
        outputRoot:      folderEdit.text,
        formatCode:      wantAlpha ? fmt.alpha : fmt.plain,
        ext:             fmt.ext,
        padding:         4,
        startFrame:      start,
        endFrame:        end,
        resX:            resW.value,
        resY:            resH.value,
        numberFolders:   numberCheck.checked,
        writeAE:         aeCheck.checked,
        writeManifest:   manifestCheck.checked,
        groupAsPrecomps: groupCheck.checked,
        saveAep:         saveAepCheck.checked,
        premult:         wantAlpha
    };
}


/* ----------------------- AE IMPORTER (.jsx) --------------------------- */

function writeAEImporter(path, meta, records)
{
    var L = [];
    L.push("// After Effects importer - auto-generated by RenderLayersToImageSequences.js");
    L.push("// In After Effects:  File > Scripts > Run Script File...  then select this file.");
    L.push("// Or from a shell:   afterfx.exe -r \"" + escC(path) + "\"");
    L.push("(function () {");
    L.push("    var SCENE = \"" + esc(meta.scene) + "\";");
    L.push("    var SCENE_FILE = \"" + esc(meta.sceneFile) + "\";");
    L.push("    var WIDTH = " + meta.width + ", HEIGHT = " + meta.height + ", FPS = " + meta.fps + ";");
    L.push("    var START = " + meta.start + ", END = " + meta.end + ", PAD = " + meta.pad + ";");
    L.push("    var EXT = \"" + meta.ext + "\";");
    L.push("    var PREMULT_BLACK = " + (meta.premult ? "true" : "false") + ";");
    L.push("    var GROUP_AS_PRECOMPS = " + (meta.groupAsPrecomps ? "true" : "false") + ";");
    L.push("    var SAVE_AEP = " + (meta.saveAep ? "true" : "false") + ";");
    L.push("    // Timeline order, top (frontmost) first. group=\"\" means ungrouped.");
    L.push("    var LAYERS = [");
    for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var comma = (i < records.length - 1) ? "," : "";
        L.push("        { folder: \"" + esc(r.folder) + "\", name: \"" + esc(r.display)
               + "\", group: \"" + esc(r.group) + "\" }" + comma);
    }
    L.push("    ];");
    L.push("");
    L.push("    function zero(n, w){ var s=\"\"+n; while(s.length<w) s=\"0\"+s; return s; }");
    L.push("    var base = (new File($.fileName)).parent;");
    L.push("    var frameCount = END - START + 1;");
    L.push("    var durSec = frameCount / FPS;");
    L.push("    app.beginUndoGroup(\"Import Harmony scene: \" + SCENE);");
    L.push("    var mainComp = app.project.items.addComp(SCENE, WIDTH, HEIGHT, 1.0, durSec, FPS);");
    L.push("");
    L.push("    // Import each layer's sequence as footage (parallel to LAYERS).");
    L.push("    var items = [], missing = [];");
    L.push("    for (var i = 0; i < LAYERS.length; i++) {");
    L.push("        var Lr = LAYERS[i];");
    L.push("        var firstName = Lr.folder + \"-\" + zero(START, PAD) + \".\" + EXT;");
    L.push("        var seqFile = new File(base.fsName + \"/\" + Lr.folder + \"/\" + firstName);");
    L.push("        if (!seqFile.exists) { missing.push(Lr.folder); items.push(null); continue; }");
    L.push("        var io = new ImportOptions(seqFile);");
    L.push("        if (frameCount > 1) io.sequence = true;");
    L.push("        io.forceAlphabetical = true;");
    L.push("        var ft;");
    L.push("        try { ft = app.project.importFile(io); } catch (e) { missing.push(Lr.folder); items.push(null); continue; }");
    L.push("        ft.name = Lr.name;");
    L.push("        try { ft.mainSource.conformFrameRate = FPS; } catch (e) {}");
    L.push("        if (PREMULT_BLACK) { try { ft.mainSource.alphaMode = AlphaMode.PREMULTIPLIED; ft.mainSource.premulColor = [0,0,0]; } catch (e) {} }");
    L.push("        items.push(ft);");
    L.push("    }");
    L.push("");
    L.push("    if (GROUP_AS_PRECOMPS) {");
    L.push("        // Build ordered slots: each character group (by first appearance) or a loose layer.");
    L.push("        var slots = [], gIndex = {};");
    L.push("        for (var i = 0; i < LAYERS.length; i++) {");
    L.push("            if (items[i] === null) continue;");
    L.push("            var g = LAYERS[i].group;");
    L.push("            if (g && g.length > 0) {");
    L.push("                if (gIndex[g] === undefined) { gIndex[g] = slots.length; slots.push({ group: g, members: [] }); }");
    L.push("                slots[gIndex[g]].members.push(items[i]);");
    L.push("            } else {");
    L.push("                slots.push({ group: null, item: items[i] });");
    L.push("            }");
    L.push("        }");
    L.push("        // Add bottom-to-top so the first slot ends up on top.");
    L.push("        for (var s = slots.length - 1; s >= 0; s--) {");
    L.push("            if (slots[s].group) {");
    L.push("                var pc = app.project.items.addComp(slots[s].group, WIDTH, HEIGHT, 1.0, durSec, FPS);");
    L.push("                var mem = slots[s].members;");
    L.push("                for (var m = mem.length - 1; m >= 0; m--) pc.layers.add(mem[m]);");
    L.push("                mainComp.layers.add(pc);");
    L.push("            } else {");
    L.push("                mainComp.layers.add(slots[s].item);");
    L.push("            }");
    L.push("        }");
    L.push("    } else {");
    L.push("        for (var i = LAYERS.length - 1; i >= 0; i--) if (items[i] !== null) mainComp.layers.add(items[i]);");
    L.push("    }");
    L.push("");
    L.push("    mainComp.openInViewer();");
    L.push("    app.endUndoGroup();");
    L.push("    if (SAVE_AEP) { try { app.project.save(new File(base.fsName + \"/\" + SCENE_FILE + \".aep\")); } catch (e) {} }");
    L.push("    if (missing.length > 0) alert(\"Imported. Missing/failed sequences:\\n\" + missing.join(\"\\n\"));");
    L.push("    else alert(\"Imported \" + LAYERS.length + \" layers into comp: \" + SCENE);");
    L.push("})();");
    return writeTextFile(path, L.join("\n"));
}


/* ------------------------- MANIFEST (.json) --------------------------- */

function writeManifest(path, meta, records)
{
    var hashes = "";
    for (var h = 0; h < meta.pad; h++) hashes += "#";

    var L = [];
    L.push("{");
    L.push("  \"scene\": \"" + esc(meta.scene) + "\",");
    L.push("  \"generator\": \"RenderLayersToImageSequences.js\",");
    L.push("  \"resolution\": { \"width\": " + meta.width + ", \"height\": " + meta.height + " },");
    L.push("  \"frameRate\": " + meta.fps + ",");
    L.push("  \"frameRange\": { \"start\": " + meta.start + ", \"end\": " + meta.end + " },");
    L.push("  \"format\": \"" + meta.ext + "\",");
    L.push("  \"framePadding\": " + meta.pad + ",");
    L.push("  \"premultipliedBlack\": " + (meta.premult ? "true" : "false") + ",");
    L.push("  \"order\": \"top layer first (index 1 = frontmost)\",");
    L.push("  \"layers\": [");
    for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var comma = (i < records.length - 1) ? "," : "";
        var pattern = r.folder + "-[" + hashes + "]." + meta.ext;
        L.push("    { \"index\": " + (i + 1)
               + ", \"name\": \"" + esc(r.display) + "\""
               + ", \"folder\": \"" + esc(r.folder) + "\""
               + ", \"group\": \"" + esc(r.group) + "\""
               + ", \"source\": \"" + esc(r.source) + "\""
               + ", \"filePattern\": \"" + esc(pattern) + "\" }" + comma);
    }
    L.push("  ]");
    L.push("}");
    return writeTextFile(path, L.join("\n"));
}


/* ------------------------- LAYER COLLECTION --------------------------- */

function getOrderedEnabledReadNodes()
{
    var ordered = [];
    var haveTimeline = false;
    try {
        var count = Timeline.numLayers;
        if (count && count > 0) {
            haveTimeline = true;
            for (var i = 0; i < count; i++) {
                if (!Timeline.layerIsNode(i)) continue;
                var path = Timeline.layerToNode(i);
                if (!path) continue;
                if (node.type(path) !== "READ") continue;
                if (!isEffectivelyEnabled(path)) continue;
                if (ordered.indexOf(path) === -1) ordered.push(path);
            }
        }
    } catch (e) { haveTimeline = false; }

    if (!haveTimeline) ordered = collectEnabledReadNodes(node.root(), true);
    return ordered;
}

function collectEnabledReadNodes(parent, parentEnabled)
{
    var result = [];
    var count = node.numberOfSubNodes(parent);
    for (var i = 0; i < count; i++) {
        var sub = node.subNode(parent, i);
        var eff = parentEnabled && node.getEnable(sub);
        if (eff && node.type(sub) === "READ") result.push(sub);
        if (node.numberOfSubNodes(sub) > 0) result = result.concat(collectEnabledReadNodes(sub, eff));
    }
    return result;
}

function isEffectivelyEnabled(path)
{
    var p = path;
    while (p && p !== "Top") {
        if (!node.getEnable(p)) return false;
        var slash = p.lastIndexOf("/");
        if (slash < 0) break;
        p = p.substring(0, slash);
    }
    return true;
}

/*
 * Character group = the first-level group under "Top".
 *   Top/Anna/Head/hair -> "Anna"      Top/bg_sky -> ""  (ungrouped)
 * Returns the raw Harmony group name (used as the AE precomp name).
 */
function getCharacterGroup(path)
{
    var parts = ("" + path).split("/");
    if (parts.length <= 2) return "";      // directly under Top
    return parts[1];
}


/* ------------------------------ SAVING -------------------------------- */

function saveCel(cel, path, formatCode)
{
    // imageFileAs(name, formatstring, optionstring): drawingType code in option.
    // If a build wants it in the format string: cel.imageFileAs(path, formatCode, "");
    cel.imageFileAs(path, "", formatCode);
}

function writeTextFile(path, content)
{
    try {
        var f = new File(path);
        f.open(FileAccess.WriteOnly);
        f.write(content);
        f.close();
        return true;
    } catch (e) {
        MessageLog.trace("Could not write file: " + path + "  (" + e + ")");
        return false;
    }
}


/* ------------------------- SCENE INFO / UI ---------------------------- */

function getSceneName()
{
    try { var n = scene.currentScene(); if (n && n.length) return n; } catch (e) {}
    return "HarmonyScene";
}

function getFrameRate()
{
    try { var r = scene.getFrameRate(); if (r && r > 0) return r; } catch (e) {}
    return 24;
}

function pumpUI()
{
    if (typeof QApplication !== "undefined" && QApplication.processEvents) QApplication.processEvents();
    else if (typeof QCoreApplication !== "undefined" && QCoreApplication.processEvents) QCoreApplication.processEvents();
}


/* ------------------------------ HELPERS ------------------------------- */

function pad(num, width) { var s = "" + num; while (s.length < width) s = "0" + s; return s; }

function makeSafeName(name) { return ("" + name).replace(/[^a-zA-Z0-9_\-]/g, "_"); }

function uniqueName(base, used) { var c = base, n = 2; while (used[c]) { c = base + "_" + n; n++; } used[c] = true; return c; }

/* Escape for a JS/JSON double-quoted string literal. */
function esc(s) { return ("" + s).replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }

/* Escape for a comment line (just strip newlines/quotes lightly). */
function escC(s) { return ("" + s).replace(/"/g, "'"); }

function ensureDir(path)
{
    var d = new Dir;
    d.path = path;
    if (!d.exists) d.mkdirs();
    return d.exists;
}


/* Entry point */
RenderLayersToImageSequences();
