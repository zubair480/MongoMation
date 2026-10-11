// Prewritten specifications behind the "Run Example" button. They run through exactly the same pipeline
// as a custom spec (job type "engineer", origin "example"); only the spec text is prewritten. Each one
// needs its Factory I/O scene registered AND verified in Atlas, otherwise the request is BLOCKED.
import type { ExampleLite } from '@/shared/mongomation';

export interface ExampleSpec extends ExampleLite {
  specText: string;
}

// Mirrors specs/examples.json in the repo root (keep them in sync).
export const EXAMPLES: readonly ExampleSpec[] = [
  {
    id: 'conveyor-jam',
    title: "Entry conveyor with start/stop, e-stop and jam protection",
    sceneId: 'sorting-by-height-basic',
    specText:
      "Control the entry conveyor of the sorting station. Pressing Start runs the entry conveyor and turns on the Start light; the conveyor keeps running after Start is released until Stop is pressed, and Stop always wins. The Emergency stop must stop the conveyor immediately. Jam protection: if the pallet sensor stays active for more than 5 seconds while the conveyor runs, stop the conveyor and latch the Stop light as a fault lamp. Reset clears the fault only once the pallet sensor is clear, and the conveyor must not restart until Start is pressed again.",
  },
  {
    id: 'sorting',
    title: "Height sorting with lane jam protection",
    sceneId: 'sorting-by-height-basic',
    specText:
      "Automate the sorting station: Start/Stop buttons run the line (Stop always wins, Emergency stop stops everything). Send tall boxes (high sensor) to the right lane and short boxes to the left lane using the chain transfer. If the left exit eye stays blocked for more than 3 seconds, stop the left conveyor and light the Reset light as a fault lamp until Reset is pressed with the eye clear.",
  },
];

export const exampleList = (): ExampleLite[] => EXAMPLES.map(({ id, title, sceneId }) => ({ id, title, sceneId }));
