/*
 * Wasm-only adapter feeding PDF bytes and fonts through MEMFS so the unchanged
 * path-based shim API runs inside one Emscripten module, plus direct MuPDF
 * font queries (the CoreText replacement) and the writer entry points the
 * native backend needs. Everything is linked statically: the shim binds the
 * same MuPDF symbols this adapter calls directly.
 */
#include "BabelDocMuPDFShim.h"

#include <mupdf/fitz.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *kBabelDocWasmInputPath = "/babeldoc-wasm-input.pdf";
static const char *kBabelDocWasmOutputPath = "/babeldoc-wasm-output.pdf";
static const char *kBabelDocWasmFontsDirectory = "/babeldoc-fonts";

static char *BabelDocWasmCopyError(const char *message) {
    size_t length = strlen(message);
    char *copy = (char *)malloc(length + 1);
    if (copy != NULL) {
        memcpy(copy, message, length + 1);
    }
    return copy;
}



static void BabelDocWasmEnsureFontsDirectory(void) {
    mkdir(kBabelDocWasmFontsDirectory, 0777);
}

static int BabelDocWasmWriteFile(const char *path, const uint8_t *bytes, int length, char **error_message) {
    FILE *file = fopen(path, "wb");
    if (file == NULL) {
        if (error_message != NULL) {
            *error_message = BabelDocWasmCopyError("Unable to open MEMFS output file.");
        }
        return -1;
    }
    size_t written = fwrite(bytes, 1, (size_t)length, file);
    int close_status = fclose(file);
    if (written != (size_t)length || close_status != 0) {
        if (error_message != NULL) {
            *error_message = BabelDocWasmCopyError("Unable to write MEMFS output file.");
        }
        return -1;
    }
    return 0;
}

static char *BabelDocWasmFontMemFSPath(const char *name) {
    size_t length = strlen(kBabelDocWasmFontsDirectory) + 1 + strlen(name) + 1;
    char *path = (char *)malloc(length);
    if (path != NULL) {
        snprintf(path, length, "%s/%s", kBabelDocWasmFontsDirectory, name);
    }
    return path;
}

/* ---------------------------------------------------------------- input ---- */

int babeldoc_wasm_extract_frontend_il(
    const uint8_t *pdf_bytes, int pdf_length, const int *page_indices, int page_count,
    char **out_json, char **error_message
) {
    if (out_json != NULL) *out_json = NULL;
    if (error_message != NULL) *error_message = NULL;
    if (pdf_bytes == NULL || pdf_length <= 0) {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("PDF input bytes are empty.");
        return -1;
    }
    if (BabelDocWasmWriteFile(kBabelDocWasmInputPath, pdf_bytes, pdf_length, error_message) != 0) {
        return -1;
    }
    return BabelDocMuPDFExtractFrontendILJSON(
        kBabelDocWasmInputPath, page_indices, page_count, NULL, out_json, error_message
    );
}

int babeldoc_wasm_render_page(
    const uint8_t *pdf_bytes, int pdf_length, int page_index, int dpi,
    uint8_t **out_pixels, int *width, int *height, int *components, char **error_message
) {
    if (out_pixels != NULL) *out_pixels = NULL;
    if (error_message != NULL) *error_message = NULL;
    if (pdf_bytes == NULL || pdf_length <= 0) {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("PDF input bytes are empty.");
        return -1;
    }
    if (BabelDocWasmWriteFile(kBabelDocWasmInputPath, pdf_bytes, pdf_length, error_message) != 0) {
        return -1;
    }

    BabelDocMuPDFImage image;
    int status = BabelDocMuPDFRenderPDFPage(
        kBabelDocWasmInputPath, page_index, dpi, NULL, &image, error_message
    );
    if (status != 0) {
        return status;
    }
    if (out_pixels != NULL) {
        *out_pixels = image.data;
    } else {
        BabelDocMuPDFFreeImage(&image);
    }
    if (width != NULL) *width = image.width;
    if (height != NULL) *height = image.height;
    if (components != NULL) *components = image.components;
    return 0;
}

/* ---------------------------------------------------------------- fonts ---- */
/* One long-lived context owns every target font opened from bytes; glyph and
 * advance queries replace the CoreText lookups the Swift pipeline used. */

#define BABELDOC_WASM_MAX_FONTS 128

static fz_context *BabelDocWasmFontContext(void);
double babeldoc_wasm_font_advance(int font_index, int glyph, double size);

static fz_context *g_font_context = NULL;
static fz_font *g_fonts[BABELDOC_WASM_MAX_FONTS];
static int g_font_count = 0;

/* Self-contained FreeType declarations (the shim keeps its own copies private):
 * opaque handles plus the leading FT_GlyphSlotRec / FT_FaceRec fields the
 * exact advance path reads. */
typedef struct BabelDocWasmFTLibraryRec *BabelDocWasmFTLibrary;
typedef struct BabelDocWasmFTFaceRec *BabelDocWasmFTFace;

extern int FT_Init_FreeType(BabelDocWasmFTLibrary *);
extern int FT_Done_FreeType(BabelDocWasmFTLibrary);
extern int FT_New_Memory_Face(BabelDocWasmFTLibrary, const unsigned char *, long, long, BabelDocWasmFTFace *);
extern int FT_Done_Face(BabelDocWasmFTFace);
extern int FT_Load_Glyph(BabelDocWasmFTFace, unsigned int, int);

typedef struct BabelDocWasmFTGlyphSlot {
    void *library;
    void *face;
    void *next;
    unsigned int glyph_index;
    void *generic_data;
    void *generic_finalizer;
    long metrics_width;
    long metrics_height;
    long metrics_horiBearingX;
    long metrics_horiBearingY;
    long metrics_horiAdvance;
    long metrics_vertBearingX;
    long metrics_vertBearingY;
    long metrics_vertAdvance;
    long linearHoriAdvance;
    long linearVertAdvance;
    long advance_x;
    long advance_y;
} BabelDocWasmFTGlyphSlot;

typedef struct BabelDocWasmFTBBoxView {
    long xMin;
    long yMin;
    long xMax;
    long yMax;
} BabelDocWasmFTBBoxView;

typedef struct BabelDocWasmFTFaceRecView {
    long num_faces;
    long face_index;
    long face_flags;
    long style_flags;
    long num_glyphs;
    char *family_name;
    char *style_name;
    int num_fixed_sizes;
    void *available_sizes;
    int num_charmaps;
    void *charmaps;
    void *generic_data;
    void *generic_finalizer;
    BabelDocWasmFTBBoxView bbox;
    unsigned short units_per_EM;
    short ascender;
    short descender;
    short height;
    short max_advance_width;
    short max_advance_height;
    short underline_position;
    short underline_thickness;
    BabelDocWasmFTGlyphSlot *glyph;
} BabelDocWasmFTFaceRecView;

/* A parallel FreeType face per opened font: font units as integers give the
 * double-precision advance CoreText reports (fz_advance_glyph returns float). */
#define BABELDOC_WASM_FT_FACES_MAX 128
static BabelDocWasmFTLibrary g_ft_library = NULL;
static BabelDocWasmFTFace g_ft_faces[BABELDOC_WASM_FT_FACES_MAX];
static unsigned char *g_ft_face_bytes[BABELDOC_WASM_FT_FACES_MAX];
static long g_ft_face_lengths[BABELDOC_WASM_FT_FACES_MAX];

static int BabelDocWasmFTEnsureLibrary(void) {
    if (g_ft_library != NULL) return 0;
    if (FT_Init_FreeType(&g_ft_library) != 0) return -1;
    return 0;
}

static void BabelDocWasmFTCloseFaces(void) {
    for (int index = 0; index < BABELDOC_WASM_FT_FACES_MAX; index += 1) {
        if (g_ft_faces[index] != NULL) {
            FT_Done_Face(g_ft_faces[index]);
            g_ft_faces[index] = NULL;
        }
        free(g_ft_face_bytes[index]);
        g_ft_face_bytes[index] = NULL;
        g_ft_face_lengths[index] = 0;
    }
    if (g_ft_library != NULL) {
        FT_Done_FreeType(g_ft_library);
        g_ft_library = NULL;
    }
}

static int BabelDocWasmFTOpenFace(int font_index, const char *path) {
    if (BabelDocWasmFTEnsureLibrary() != 0) return -1;
    FILE *file = fopen(path, "rb");
    if (file == NULL) return -1;
    fseek(file, 0, SEEK_END);
    long length = ftell(file);
    fseek(file, 0, SEEK_SET);
    if (length <= 0) {
        fclose(file);
        return -1;
    }
    unsigned char *bytes = (unsigned char *)malloc((size_t)length);
    if (bytes == NULL || fread(bytes, 1, (size_t)length, file) != (size_t)length) {
        free(bytes);
        fclose(file);
        return -1;
    }
    fclose(file);
    BabelDocWasmFTFace face = NULL;
    if (FT_New_Memory_Face(g_ft_library, bytes, length, 0, &face) != 0 || face == NULL) {
        free(bytes);
        return -1;
    }
    g_ft_faces[font_index] = face;
    g_ft_face_bytes[font_index] = bytes;
    g_ft_face_lengths[font_index] = length;
    return 0;
}

/* CoreText reports (units / upem) * size in double; mirror that exactly. */
double babeldoc_wasm_font_advance_exact(int font_index, int glyph, double size) {
    if (font_index < 0 || font_index >= g_font_count || glyph < 0) return size;
    BabelDocWasmFTFace face = g_ft_faces[font_index];
    if (face == NULL) return babeldoc_wasm_font_advance(font_index, glyph, size);
    if (FT_Load_Glyph(face, (unsigned int)glyph, 0x1000 /* FT_LOAD_NO_SCALE */) != 0) {
        return babeldoc_wasm_font_advance(font_index, glyph, size);
    }
    BabelDocWasmFTFaceRecView *record = (BabelDocWasmFTFaceRecView *)(void *)face;
    long units_per_em = record->units_per_EM;
    long advance_units = record->glyph->advance_x;
    if (units_per_em <= 0) return babeldoc_wasm_font_advance(font_index, glyph, size);
    return size / (double)units_per_em * (double)advance_units;
}

double babeldoc_wasm_font_advance(int font_index, int glyph, double size) {
    if (font_index < 0 || font_index >= g_font_count || glyph < 0) return size;
    fz_context *ctx = BabelDocWasmFontContext();
    float advance = 0.0f;
    fz_try(ctx) {
        advance = fz_advance_glyph(ctx, g_fonts[font_index], glyph, 0);
    }
    fz_catch(ctx) {
        return size;
    }
    return (double)advance * size;
}


static fz_context *BabelDocWasmFontContext(void) {
    if (g_font_context == NULL) {
        g_font_context = fz_new_context(NULL, NULL, FZ_STORE_UNLIMITED);
        if (g_font_context != NULL) {
            fz_register_document_handlers(g_font_context);
        }
    }
    return g_font_context;
}


int babeldoc_wasm_font_open(
    const uint8_t *font_bytes, int font_length, const char *name, char **error_message
) {
    if (error_message != NULL) *error_message = NULL;
    if (font_bytes == NULL || font_length <= 0 || name == NULL || name[0] == '\0') {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Font input is empty.");
        return -1;
    }
    if (g_font_count >= BABELDOC_WASM_MAX_FONTS) {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Too many open fonts.");
        return -1;
    }
    char *path = BabelDocWasmFontMemFSPath(name);
    if (path == NULL) {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Unable to allocate font path.");
        return -1;
    }
    BabelDocWasmEnsureFontsDirectory();
    int status = BabelDocWasmWriteFile(path, font_bytes, font_length, error_message);
    if (status != 0) {
        free(path);
        return -1;
    }

    fz_context *ctx = BabelDocWasmFontContext();
    if (ctx == NULL) {
        free(path);
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Unable to create font context.");
        return -1;
    }
    fz_font *font = NULL;
    fz_try(ctx) {
        font = fz_new_font_from_file(ctx, name, path, 0, 1);
    }
    fz_catch(ctx) {
        free(path);
        if (error_message != NULL) {
            *error_message = BabelDocWasmCopyError("MuPDF could not open the font.");
        }
        return -1;
    }
    if (font == NULL) {
        free(path);
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("MuPDF could not open the font.");
        return -1;
    }
    g_fonts[g_font_count] = font;
    int index = g_font_count;
    g_font_count += 1;
    if (BabelDocWasmFTOpenFace(index, path) != 0) {
        /* The float path still works without the FT face. */
    }
    free(path);
    return index;
}


int babeldoc_wasm_font_glyph(int font_index, int unicode) {
    if (font_index < 0 || font_index >= g_font_count || unicode < 0) return -1;
    fz_context *ctx = BabelDocWasmFontContext();
    int glyph = -1;
    fz_try(ctx) {
        glyph = fz_encode_character(ctx, g_fonts[font_index], unicode);
    }
    fz_catch(ctx) {
        return -1;
    }
    return glyph;
}


int babeldoc_wasm_font_names_match(const char *resource_name, const char *runtime_name) {
    return BabelDocMuPDFFontNamesMatch(resource_name, runtime_name);
}


void babeldoc_wasm_font_reset(void) {
    if (g_font_context != NULL) {
        for (int index = 0; index < g_font_count; index += 1) {
            fz_drop_font(g_font_context, g_fonts[index]);
            g_fonts[index] = NULL;
        }
        g_font_count = 0;
    }
    BabelDocWasmFTCloseFaces();
}

/* --------------------------------------------------------------- base ops -- */

int babeldoc_wasm_decode_base_operations(
    const char *encoded, char **out_text, char **error_message
) {
    return BabelDocMuPDFDecodeBaseOperations(encoded, out_text, error_message);
}

/* ---------------------------------------------------------------- writer --- */

int babeldoc_wasm_writer_open(
    const uint8_t *pdf_bytes, int pdf_length, int **out_writer, char **error_message
) {
    if (out_writer != NULL) *out_writer = NULL;
    if (error_message != NULL) *error_message = NULL;
    if (BabelDocWasmWriteFile(kBabelDocWasmInputPath, pdf_bytes, pdf_length, error_message) != 0) {
        return -1;
    }
    BabelDocMuPDFWriter *writer = NULL;
    int status = BabelDocMuPDFWriterOpen(kBabelDocWasmInputPath, NULL, &writer, error_message);
    if (status == 0 && writer != NULL && out_writer != NULL) {
        *out_writer = (int *)writer;
    } else if (writer != NULL) {
        BabelDocMuPDFWriterClose(writer);
    }
    return status;
}

int babeldoc_wasm_writer_add_cid_font(
    int *writer, int page_index, int owner_xref, const char *resource_name,
    const char *font_name, char **error_message
) {
    if (error_message != NULL) *error_message = NULL;
    if (writer == NULL || resource_name == NULL || font_name == NULL) {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Invalid CID font writer arguments.");
        return -1;
    }
    char *path = BabelDocWasmFontMemFSPath(font_name);
    if (path == NULL) {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Unable to allocate font path.");
        return -1;
    }
    int status = BabelDocMuPDFWriterAddCIDFont(
        (BabelDocMuPDFWriter *)writer, page_index, owner_xref, resource_name, path, error_message
    );
    free(path);
    return status;
}

int babeldoc_wasm_writer_set_page_content(
    int *writer, int page_index, const uint8_t *content, int content_length, char **error_message
) {
    if (error_message != NULL) *error_message = NULL;
    return BabelDocMuPDFWriterSetPageContent(
        (BabelDocMuPDFWriter *)writer, page_index, content, content_length, error_message
    );
}

int babeldoc_wasm_writer_set_object_content(
    int *writer, int object_xref, const uint8_t *content, int content_length, char **error_message
) {
    if (error_message != NULL) *error_message = NULL;
    return BabelDocMuPDFWriterSetObjectContent(
        (BabelDocMuPDFWriter *)writer, object_xref, content, content_length, error_message
    );
}

int babeldoc_wasm_writer_keep_pages(
    int *writer, const int *page_indices, int page_count, char **error_message
) {
    if (error_message != NULL) *error_message = NULL;
    return BabelDocMuPDFWriterKeepPages(
        (BabelDocMuPDFWriter *)writer, page_indices, page_count, error_message
    );
}

int babeldoc_wasm_writer_save(
    int *writer, uint8_t **out_bytes, int *out_length, char **error_message
) {
    if (out_bytes != NULL) *out_bytes = NULL;
    if (out_length != NULL) *out_length = 0;
    if (error_message != NULL) *error_message = NULL;
    int status = BabelDocMuPDFWriterSave(
        (BabelDocMuPDFWriter *)writer, kBabelDocWasmOutputPath, error_message
    );
    if (status != 0) {
        return status;
    }
    FILE *file = fopen(kBabelDocWasmOutputPath, "rb");
    if (file == NULL) {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Saved PDF is unreadable.");
        return -1;
    }
    fseek(file, 0, SEEK_END);
    long length = ftell(file);
    fseek(file, 0, SEEK_SET);
    if (length <= 0) {
        fclose(file);
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Saved PDF is empty.");
        return -1;
    }
    uint8_t *bytes = (uint8_t *)malloc((size_t)length);
    if (bytes == NULL || fread(bytes, 1, (size_t)length, file) != (size_t)length) {
        free(bytes);
        fclose(file);
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Saved PDF could not be read.");
        return -1;
    }
    fclose(file);
    if (out_bytes != NULL) *out_bytes = bytes;
    else free(bytes);
    if (out_length != NULL) *out_length = (int)length;
    return 0;
}

void babeldoc_wasm_writer_close(int *writer) {
    if (writer != NULL) {
        BabelDocMuPDFWriterClose((BabelDocMuPDFWriter *)writer);
    }
}

/* -------------------------------------------------- source preserving plan -- */

int babeldoc_wasm_writer_apply_source_preserving_page(
    int *writer,
    int page_index,
    const double *anchor_values,      /* 8 per anchor: x, y, y2, orientation, unicode, role, placement, optional */
    int anchor_count,
    const double *placement_values,   /* 7 per placement: a, b, c, d, e, f, first_rect */
    int placement_count,
    const double *rect_values,        /* 5 per rect: x, y, x2, y2, is_graphic */
    int rect_count,
    const double *removed_regions,    /* 4 doubles per region */
    int removed_region_count,
    const double *removed_text_regions,
    int removed_text_region_count,
    const uint8_t *underlay, int underlay_length,
    const uint8_t *overlay, int overlay_length,
    double maximum_unmatched_fraction,
    int *out_report,                  /* 14 int32 values, mirroring BabelDocSourcePageReport */
    char **error_message
) {
    if (error_message != NULL) *error_message = NULL;
    if (writer == NULL || out_report == NULL) {
        if (error_message != NULL) *error_message = BabelDocWasmCopyError("Invalid source-preserving arguments.");
        return -1;
    }

    BabelDocSourceGlyphAnchor *anchors = NULL;
    BabelDocSourcePlacement *placements = NULL;
    BabelDocSourcePlacementRect *rects = NULL;
    double *regions[2] = { NULL, NULL };
    int status = -1;

    if (anchor_count > 0) {
        anchors = (BabelDocSourceGlyphAnchor *)calloc((size_t)anchor_count, sizeof(*anchors));
        if (anchors == NULL) goto finish;
        for (int index = 0; index < anchor_count; index += 1) {
            const double *values = anchor_values + index * 8;
            anchors[index].x = values[0];
            anchors[index].y = values[1];
            anchors[index].y2 = values[2];
            anchors[index].orientation = (int)values[3];
            anchors[index].unicode = values[4] < 0 ? -1 : (int)values[4];
            anchors[index].role = (int)values[5];
            anchors[index].placement = (int)values[6];
            anchors[index].optional = (int)values[7];
        }
    }
    if (placement_count > 0) {
        placements = (BabelDocSourcePlacement *)calloc((size_t)placement_count, sizeof(*placements));
        if (placements == NULL) goto finish;
        for (int index = 0; index < placement_count; index += 1) {
            const double *values = placement_values + index * 7;
            placements[index].transform[0] = values[0];
            placements[index].transform[1] = values[1];
            placements[index].transform[2] = values[2];
            placements[index].transform[3] = values[3];
            placements[index].transform[4] = values[4];
            placements[index].transform[5] = values[5];
            placements[index].first_rect = (int)values[6];
            placements[index].rect_count = 0;
        }
    }
    if (rect_count > 0) {
        rects = (BabelDocSourcePlacementRect *)calloc((size_t)rect_count, sizeof(*rects));
        if (rects == NULL) goto finish;
        for (int index = 0; index < rect_count; index += 1) {
            const double *values = rect_values + index * 5;
            rects[index].box[0] = values[0];
            rects[index].box[1] = values[1];
            rects[index].box[2] = values[2];
            rects[index].box[3] = values[3];
            rects[index].is_graphic = (int)values[4];
        }
    }
    for (int pass = 0; pass < 2; pass += 1) {
        const double *source = pass == 0 ? removed_regions : removed_text_regions;
        int count = pass == 0 ? removed_region_count : removed_text_region_count;
        if (count <= 0) continue;
        regions[pass] = (double *)calloc((size_t)count * 4, sizeof(double));
        if (regions[pass] == NULL) goto finish;
        memcpy(regions[pass], source, sizeof(double) * (size_t)count * 4);
    }
    /* Rect counts are only known once every placement has been packed. */
    for (int index = 0; index < placement_count; index += 1) {
        int first = placements[index].first_rect;
        int next = index + 1 < placement_count ? placements[index + 1].first_rect : rect_count;
        placements[index].rect_count = next - first;
    }

    {
        BabelDocSourcePagePlan plan;
        memset(&plan, 0, sizeof(plan));
        plan.anchors = anchors;
        plan.anchor_count = anchor_count;
        plan.placements = placements;
        plan.placement_count = placement_count;
        plan.placement_rects = rects;
        plan.placement_rect_count = rect_count;
        plan.removed_regions = regions[0];
        plan.removed_region_count = removed_region_count;
        plan.removed_text_regions = regions[1];
        plan.removed_text_region_count = removed_text_region_count;
        plan.underlay = underlay;
        plan.underlay_length = underlay_length;
        plan.overlay = overlay;
        plan.overlay_length = overlay_length;
        plan.maximum_unmatched_fraction = maximum_unmatched_fraction;

        BabelDocSourcePageReport report;
        memset(&report, 0, sizeof(report));
        status = BabelDocMuPDFWriterApplySourcePreservingPage(
            (BabelDocMuPDFWriter *)writer, page_index, &plan, &report, error_message
        );
        out_report[0] = report.status;
        out_report[1] = report.fallback_reason;
        out_report[2] = report.glyph_count;
        out_report[3] = report.anchor_count;
        out_report[4] = report.required_anchor_count;
        out_report[5] = report.unmatched_required_anchor_count;
        out_report[6] = report.unmatched_placement_anchor_count;
        out_report[7] = report.removed_glyph_count;
        out_report[8] = report.placed_glyph_count;
        out_report[9] = report.adopted_glyph_count;
        out_report[10] = report.removed_graphic_count;
        out_report[11] = report.placed_graphic_count;
        out_report[12] = report.layer_count;
        out_report[13] = report.misplaced_glyph_count;
    }

finish:
    free(anchors);
    free(placements);
    free(rects);
    free(regions[0]);
    free(regions[1]);
    return status;
}

void babeldoc_wasm_free(void *pointer) {
    free(pointer);
}
