/**
 * The drag data format that says "what is being dragged is an Annotation".
 *
 * Two lists on this screen accept drops and they are nested one inside the other: an Annotation row
 * dropped on a row reorders a collection, and the same row dropped on another Layer's card moves it
 * between files. `LayerList` therefore has to tell an Annotation being dragged from a Layer being
 * dragged, and it has to tell them apart *during `dragover`* — where `getData` returns the empty
 * string under the drag-and-drop protected mode every browser implements, and `dataTransfer.types`
 * is all that can be read. So the fact is carried by the presence of a format rather than by its
 * contents.
 *
 * Lower case because `DataTransfer` lower-cases every format it is given, so a mixed-case constant
 * would be a string that never matches what `types` reports.
 */
export const ANNOTATION_DRAG_TYPE = 'application/x-ballastella-annotation';
