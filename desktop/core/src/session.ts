// Oben im File:
import { InteractionTester } from "./interaction"; // Statt HumanBehavior

// ... innerhalb der run() Methode von SessionRunner, dort wo bisher humanize stand:

// ALT:
// const human = this.cfg.humanize ? new HumanBehavior(page, this.abort.signal).run() : Promise.resolve();

// NEU:
let interactionPromise = Promise.resolve();
const useInteraction = this.cfg.interaction?.mode !== "off" || this.cfg.humanize;

if (useInteraction) {
  const interactionConfig = this.cfg.interaction?.mode !== "off" 
    ? this.cfg.interaction 
    : { mode: "random" as const }; // Fallback auf Random, wenn nur das alte "humanize: true" gesetzt ist
  
  const tester = new InteractionTester(page, this.abort.signal, interactionConfig);
  interactionPromise = tester.run();
}

const repeater = this.cfg.repeat ? this.repeatLoop(page) : Promise.resolve();

// ... Rest bleibt gleich, aber await Promise.allSettled([human, repeater]) ändern zu:
await Promise.allSettled([interactionPromise, repeater]);
