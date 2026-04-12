Implement a robust, event-driven and extensible "Comms System" for our 3D space exploration game built with Next.js, react-three-fiber (R3F), and WebGPU. I need the data structure, the state manager, the trigger system, and the React UI component. 

Here are the strict architectural requirements:

1. DATA STRUCTURE (Separation of Concerns)
Create a TypeScript interface for a `Message` that includes:
- `messageId` (string, unique)
- `speaker` (string, e.g., "Ground Control")
- `textContent` (string)
- `audioClip` (string/optional)
- `priority` (number, e.g., 1=Low, 2=High)
- `hasPlayed` (boolean)
Data should be stored in JSON.

2. STATE MANAGEMENT & QUEUE (The Comms Manager)
Implement a global state manager (e.g., using Zustand or React Context) to handle the message queue. 
- It must listen for incoming messages.
- It must handle overlapping triggers using a Queue. High-priority messages should interrupt or jump the line; low-priority messages get queued.
- It must maintain a persistent registry of `messageId`s that have `hasPlayed: true` so they do not replay upon reloading the game (Save/Load Amnesia).

3. TRIGGER SYSTEM
Provide examples of how to hook into this system via three methods without tightly coupling the game logic to the UI:
- Action Triggers: A function call when an event happens (e.g., `onAsteroidMined`, `onShipDamaged`, `onMiningLaserOverheat` etc).
- Spatial Triggers: A React-Three-Fiber component (invisible box/sphere) that triggers a message when the player's 3D position intersects it.
- Stat Triggers: A listener that fires when a game state changes (e.g., health drops below 20%).

4. UI OVERLAY (Manual Dismissal & Scaling)
Create a React UI component (HTML/CSS layered over the R3F canvas) to display the active message.
- STRICT RULE: Messages MUST NOT disappear automatically. The user must explicitly press a button (e.g., clicking 'Continue' or pressing the Space key) to dismiss the message and advance the queue.
- The UI must gracefully handle long strings of text (via pagination) so text never spills out of the container. In case you need to do text calculation & layout yourself, you can use the @chenglou/pretext library (https://github.com/chenglou/pretext)

To verify it works, start with two simple messages:
1. A medium-priority that plays right at the start of the first game scene, welcoming the player:
```json
{
  "messageId": "welcome_001",
  "speaker": "Ground Control",
  "textContent": "Nomad, this is Flight Director Aris. Signal check... okay, we have you. Systems check shows your hull integrity is nominal. Remember, your mission is to aid us in research and to collect rare resources. If all goes well, this might help us save Earth before it's too late. You should see an asteroid field nearby. Try mining one of the asteroids to get familiar with your scanner and mining laser. Good luck out there, Nomad! We are counting on you.",
  "priority": 2,
  "hasPlayed": false
}
```
2. A low-priority message that triggers when the player mines their first asteroid:
```json
{
  "messageId": "mining_001",
  "speaker": "Ground Control",
  "textContent": "Great job, Nomad! Along with some resources, you just collected your first assay sample. That was the last piece of data we needed to start researching your MicroLab. This onboard lab will allow you to analyze samples and conduct experiments while you're out in space. It's a crucial tool for your mission, so make sure to use it often. To access the MicroLab, open the research panel and click the start button right next to the MicroLab. Once the research is complete, you'll be able to research new technologies and upgrades that will help you on your journey. Keep up the good work, Nomad! We're here to support you every step of the way.",
  "priority": 1,
  "hasPlayed": false
}
```

If you have any questions or improvement suggestions, please let me know!
