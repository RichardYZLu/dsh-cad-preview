import FreeCAD as App
import Part
cone = Part.makeCone(50.0, 0.0, 120.0)  # base circle on z = 0
box = cone.BoundBox
print("bbox", box.XMin, box.YMin, box.ZMin, box.XMax, box.YMax, box.ZMax)
doc = App.newDocument("Cone")
obj = doc.addObject("Part::Feature", "Cone")
obj.Shape = cone
doc.recompute()
Part.export([obj], "/Volumes/exSSD/DSH/DSH-Plugins/dsh-cad-preview/test/fixtures/cone-r50-h120.step")
