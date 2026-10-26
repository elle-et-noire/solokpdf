/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

// Annotations of an engine other than EngineMupdf (EnginePdfium). The EngineMupdf* annotation
// entry points and the Annotation.cpp accessors forward to it when the engine or the
// Annotation has one, so callers stay engine-agnostic. Geometry is in page coordinates,
// like EngineMupdf's annotations.
struct Annotation;
struct AnnotCreateArgs;

struct AnnotationBackend {
    virtual ~AnnotationBackend() = default;

    // every non-widget annotation, loading pages as needed (loadedOnly: those read so far)
    virtual void GetAnnotations(Vec<Annotation*>& out, bool loadedOnly) = 0;
    virtual Annotation* GetAnnotationAtPos(int pageNo, PointF pos, float padding, Annotation* preferred) = 0;
    virtual Annotation* Create(int pageNo, PointF pos, AnnotCreateArgs* args) = 0;
    virtual bool HasUnsaved() = 0;
    // empty path: the document's own file
    virtual bool SaveUpdated(Str path, const Func1<Str>& showError) = 0;
    virtual bool SaveCopy(Str path) = 0;

    virtual bool IsLive(Annotation*) = 0;
    virtual RectF Bounds(Annotation*) = 0;
    virtual void SetRect(Annotation*, RectF) = 0;
    virtual Vec<RectF> QuadPoints(Annotation*) = 0;
    virtual void SetQuadPoints(Annotation*, const Vec<RectF>&) = 0;
    virtual Str Contents(Annotation*) = 0; // temp
    virtual bool SetContents(Annotation*, Str) = 0;
    virtual Str Author(Annotation*) = 0; // temp
    virtual time_t ModificationDate(Annotation*) = 0;
    virtual void SetModificationDateToNow(Annotation*) = 0;
    virtual PdfColor Color(Annotation*, bool interior) = 0;
    virtual bool SetColor(Annotation*, PdfColor, bool interior) = 0;
    virtual int Opacity(Annotation*) = 0; // 0-255
    virtual void SetOpacity(Annotation*, int) = 0;
    virtual int BorderWidth(Annotation*) = 0;
    virtual void SetBorderWidth(Annotation*, int) = 0;
    virtual Str IconName(Annotation*) = 0; // temp
    virtual void InkList(Annotation*, Vec<int>& strokeCounts, Vec<PointF>& points) = 0;
    virtual bool SetInkList(Annotation*, const Vec<int>& strokeCounts, const Vec<PointF>& points) = 0;
    // removes it from the document and the backend; the caller deletes the Annotation
    virtual void Delete(Annotation*) = 0;
};
