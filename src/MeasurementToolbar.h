/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

struct MainWindow;
struct Gfx;

enum class MeasurementHover {
    Unclaimed,
    Handled,
    Busy,
};

void ToggleMeasurement(MainWindow*);
void CloseMeasurement(MainWindow*);
bool MeasurementCancel(MainWindow*);
bool MeasurementOnClick(MainWindow*, Point, bool ctrl);
MeasurementHover MeasurementOnMove(MainWindow*, Point);
void PaintMeasurement(MainWindow*, Gfx*);
TempStr TestMeasurement(MainWindow*, Str action, int pageNo, PointF, Str length, Str unit);
