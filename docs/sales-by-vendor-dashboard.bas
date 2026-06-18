Attribute VB_Name = "SalesByVendorDashboard"
' ============================================================================
'  Sales by Vendor - PivotChart dashboard builder
' ----------------------------------------------------------------------------
'  Run this on a "Sales by Vendor" Excel export (a workbook that has a "Data"
'  sheet / "SalesData" table). It builds, on a fresh "Pivot Dashboard" sheet:
'    - a PivotTable (Month down the rows, Year across the columns, Sum of Ex-VAT)
'    - a clustered-column PivotChart that plots the prior year against the
'      current year, month by month
'    - Vendor / Item / Site slicers you click to filter everything at once.
'
'  Because the Data sheet stores each year as its own ROWS (Year = 2025 / 2026,
'  same Month), the chart shows a real year-over-year comparison.
'
'  INSTALL ONCE (so it works on every export, with no macro-security blocking):
'    1. Excel > Alt+F11 (VBA editor).
'    2. In the Project Explorer, find "VBAProject (PERSONAL.XLSB)". If it isn't
'       there, first record any dummy macro (View > Macros > Record Macro, store
'       in "Personal Macro Workbook", stop) to create it, then come back.
'    3. Right-click PERSONAL.XLSB > Import File... and pick this .bas
'       (or insert a Module and paste this code in).
'    4. Save. Now open any Sales-by-Vendor export, press Alt+F8, and run
'       "BuildSalesByVendorDashboard".
'
'  Requires Excel 2013+ (uses slicers). To chart units instead of rands, swap
'  "Ex-VAT" for "Qty" in the PivotTable field list.
' ============================================================================
Option Explicit

Public Sub BuildSalesByVendorDashboard()
    Dim wb As Workbook, dataWs As Worksheet, dashWs As Worksheet
    Dim lo As ListObject, src As Range
    Dim pc As PivotCache, pt As PivotTable

    Set wb = ActiveWorkbook

    On Error Resume Next
    Set dataWs = wb.Worksheets("Data")
    On Error GoTo 0
    If dataWs Is Nothing Then
        MsgBox "No 'Data' sheet found - open a Sales by Vendor export first.", vbExclamation
        Exit Sub
    End If

    ' Prefer the named table; fall back to the used range.
    On Error Resume Next
    Set lo = dataWs.ListObjects("SalesData")
    On Error GoTo 0
    If lo Is Nothing Then Set src = dataWs.UsedRange Else Set src = lo.Range

    ' Rebuild a clean dashboard sheet each run.
    Application.DisplayAlerts = False
    On Error Resume Next
    wb.Worksheets("Pivot Dashboard").Delete
    On Error GoTo 0
    Application.DisplayAlerts = True
    Set dashWs = wb.Worksheets.Add(After:=dataWs)
    dashWs.Name = "Pivot Dashboard"

    ' PivotTable, lower down so slicers + chart sit above it.
    Set pc = wb.PivotCaches.Create(SourceType:=xlDatabase, SourceData:=src)
    Set pt = pc.CreatePivotTable(TableDestination:=dashWs.Range("A18"), TableName:="SalesPivot")

    With pt
        .PivotFields("Month").Orientation = xlRowField
        .PivotFields("Year").Orientation = xlColumnField
        With .PivotFields("Ex-VAT")
            .Orientation = xlDataField
            .Function = xlSum
            .Name = "Ex-VAT"
            .NumberFormat = "#,##0.00"
        End With
        .RowAxisLayout xlTabularRow
        .ShowTableStyleRowStripes = True
    End With

    ' PivotChart - clustered columns, year over year.
    Dim co As ChartObject
    Set co = dashWs.ChartObjects.Add(Left:=dashWs.Range("D2").Left, Top:=dashWs.Range("D2").Top, _
                                     Width:=620, Height:=300)
    co.Chart.SetSourceData Source:=pt.TableRange1
    co.Chart.ChartType = xlColumnClustered
    co.Chart.HasTitle = True
    co.Chart.ChartTitle.Text = "Ex-VAT by month - year over year"

    ' Slicers (only added if the field exists in the pivot).
    AddSlicer wb, pt, dashWs, "Vendor", 10
    AddSlicer wb, pt, dashWs, "Item", 130
    AddSlicer wb, pt, dashWs, "Site", 250

    dashWs.Activate
    dashWs.Range("A1").Select
    MsgBox "Dashboard built on the 'Pivot Dashboard' sheet." & vbCrLf & _
           "Click the Vendor slicer to filter. Swap Ex-VAT for Qty in the " & _
           "field list to chart units.", vbInformation
End Sub

Private Sub AddSlicer(wb As Workbook, pt As PivotTable, ws As Worksheet, _
                      fieldName As String, leftPos As Single)
    Dim pf As PivotField, sc As SlicerCache
    On Error Resume Next
    Set pf = pt.PivotFields(fieldName)
    On Error GoTo 0
    If pf Is Nothing Then Exit Sub          ' field not present (e.g. Site on a single-site export)

    On Error Resume Next
    Set sc = wb.SlicerCaches.Add2(pt, fieldName)
    If sc Is Nothing Then Set sc = wb.SlicerCaches.Add(pt, fieldName)   ' older Excel
    If Not sc Is Nothing Then
        sc.Slicers.Add SlicerDestination:=ws, Top:=ws.Range("A2").Top, _
                       Left:=leftPos, Width:=110, Height:=200
    End If
    On Error GoTo 0
End Sub
