import FreeCAD as App, Part
shapes = []
for i in range(12):
    for j in range(12):
        for k in range(12):
            s = Part.makeSphere(2.0)
            s.translate(App.Vector(i * 5.0, j * 5.0, k * 5.0))
            shapes.append(s)
compound = Part.makeCompound(shapes)
doc = App.newDocument("Stress")
obj = doc.addObject("Part::Feature", "Stress")
obj.Shape = compound
doc.recompute()
Part.export([obj], "/Volumes/exSSD/DSH/DSH-Plugins/dsh-cad-preview/test/fixtures/stress/stress-a-1728spheres.step")
print("exported", 1728, "spheres")
