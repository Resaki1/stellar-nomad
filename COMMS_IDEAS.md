 ---
  Improvements to Existing Messages

  ai_intro_001 — The third page is literally "..." which reads as a placeholder. I'd replace it with a subtle personality beat — the AI noticing something or making an observation that hints at depth. Something like: "Interesting. The Archimedes II has significantly more shielded storage
  capacity than a standard mining vessel. Likely a redundancy measure. Uplink established." This seeds the foreshadowing while also being the AI's first moment of independent thought.

  welcome_001 — Solid, but could lean harder into the urgency from STORY.md. Stern is described as "clipped, professional, information-dense." The current middle paragraph ("Here's where things stand...") is good but could include a specific, chilling detail to sell the desperation.
  Something referencing the methane cascade or atmospheric data — ground it in the specific science from the story bible.

  mining_001 — The MicroLab tutorial content is necessary, but the tone could be more Stern-like. Currently ends with "Keep it up, Nomad. Ground Control out." — which is fine. But Stern should maybe add a line about how important the assay data is: research isn't a side activity, it's the
  mission. Makes the player feel the weight.

  ---
  New Messages — Organized by Phase

  Phase 1: Tutorial Reactive (first 10 minutes)

  These fire in response to things the player naturally does in the first session.

  ┌──────────────────┬─────────────┬────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │        ID        │   Speaker   │                        Trigger                         │                                                    Purpose                                                     │
  ├──────────────────┼─────────────┼────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ first_damage_001 │ {{AI_NAME}} │ CommsStatWatcher: health < maxHealth (first time only) │ AI warns about hull damage. Professional but with a hint of concern. Teaches the player that damage matters.   │
  ├──────────────────┼─────────────┼────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ overheat_001     │ {{AI_NAME}} │ CommsStatWatcher: isOverheated becomes true            │ AI explains the mining laser has thermal limits. Suggests pacing. Quick, functional.                           │
  ├──────────────────┼─────────────┼────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ cargo_full_001   │ {{AI_NAME}} │ CommsStatWatcher: isCargoFullAtom becomes true         │ AI notes cargo hold is at capacity. Suggests crafting modules or checking the research panel to use resources. │
  └──────────────────┴─────────────┴────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  Example — first_damage_001:

  ▎ {{AI_NAME}}: "Hull breach detected. Integrity at {{HEALTH}}%... actually, let me rephrase. You hit something. I've rerouted power to structural reinforcement. I'd recommend reducing velocity near dense asteroid clusters."

  (The self-correction — "let me rephrase" — is the first moment the AI sounds like more than a readout. Subtle.)

  Example — overheat_001:

  ▎ {{AI_NAME}}: "Mining laser thermal capacity exceeded. Forced cooldown initiated. The optics need time to dissipate — sustained fire will always trigger this. Shorter bursts are more efficient."

  Example — cargo_full_001:

  ▎ {{AI_NAME}}: "Cargo hold at maximum capacity. You'll need to use these materials before you can store more. The research panel or crafting system would be a good place to start."

  ---
  Phase 2: Progression Milestones (10–30 minutes)

  These reward the player for advancing and push the story forward.

  ┌───────────────────────┬─────────────┬───────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────┐
  │          ID           │   Speaker   │                            Trigger                            │                                            Purpose                                             │
  ├───────────────────────┼─────────────┼───────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ research_start_001    │ {{AI_NAME}} │ useCommsTrigger when r0_microlab_boot starts                  │ AI comments on the MicroLab booting up. Brief, functional.                                     │
  ├───────────────────────┼─────────────┼───────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ research_complete_001 │ Dr. Stern   │ useCommsTrigger when r0_microlab_boot completes               │ Stern is pleased. Opens the tech tree narratively. First hint of bigger goals.                 │
  ├───────────────────────┼─────────────┼───────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ first_craft_001       │ {{AI_NAME}} │ useCommsTrigger after first module craft                      │ AI confirms installation. A small personality beat — maybe it has an opinion about the module. │
  ├───────────────────────┼─────────────┼───────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ elara_001             │ Elara       │ Fires after research_complete_001 is played (or time-delayed) │ First personal message. Awkward, human, achingly real.                                         │
  └───────────────────────┴─────────────┴───────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────┘

  Example — research_complete_001:

  ▎ Dr. Stern: "Nomad, we're receiving your MicroLab telemetry. Good — the analysis framework is operational. This gives you access to the full research tree. Each assay sample you collect out there feeds directly into our models."
  ▎ "I won't sugarcoat it. The atmospheric data from this morning is worse than projected. The methane cascade is accelerating. Every breakthrough you make out there buys us time down here."
  ▎ "Check the research panel. Prioritize based on what you need most. Ground Control out."

  Example — elara_001:

  ▎ Elara: "Hey. They told me I could send messages through the relay. I don't really know what to say. I guess... how's space?"
  ▎ "Water rations got cut again. Mika keeps trying to drink from the toilet. That's the dog, not a person. Although honestly, some people here aren't much better."
  ▎ "I don't know if you even get these. But... be careful up there. Or whatever the appropriate sentiment is for someone floating alone in the void."

  (Elara's messages should feel like someone writing into a void. Awkward pauses, humor as a defense mechanism. No avatar — she's not official ESA comms. This makes her messages feel distinct from Stern's polished briefings.)

  ---
  Phase 3: Mid-Game Story Building (30–60 minutes)

  The player is comfortable with systems. Now deepen the world and start foreshadowing.

  ┌──────────────────┬─────────────┬─────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │        ID        │   Speaker   │                 Trigger                 │                                                    Purpose                                                    │
  ├──────────────────┼─────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ stern_update_001 │ Dr. Stern   │ After several researches completed (3+) │ Earth situation update. Things are getting worse. Professional exterior cracking slightly.                    │
  ├──────────────────┼─────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ ai_manifest_001  │ {{AI_NAME}} │ After first few modules crafted (3+)    │ Foreshadowing. AI found a restricted file in the ship manifest. Can't access it. Notes it's unusual.          │
  ├──────────────────┼─────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ elara_002        │ Elara       │ After stern_update_001 is played        │ Second personal message. More vulnerable. Mentions the situation on Earth getting worse from her perspective. │
  ├──────────────────┼─────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ first_death_001  │ {{AI_NAME}} │ After respawn (first death only)        │ AI explains the wreck system. Dry observation about the situation.                                            │
  └──────────────────┴─────────────┴─────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  Example — stern_update_001:

  ▎ Dr. Stern: "Nomad, status update from Ground Control. The northern permafrost collapse has accelerated. We're seeing methane readings 40% above last month's models. Crop yields in the northern hemisphere are... not good."
  ▎ "International cooperation is holding, but barely. Three nations pulled out of the joint atmospheric program last week. Everyone wants to save themselves first. Can't blame them."
  ▎ "Your work out there matters more than you know. Keep sending those assay samples. Stern out."

  Example — ai_manifest_001:

  ▎ {{AI_NAME}}: "I've been running routine system audits. Standard procedure. I found an anomaly in the ship's cargo manifest — a section flagged as classified, requiring authorization I don't have."
  ▎ "This is unusual. I have full access to every other system on this vessel. Life support, navigation, reactor controls. But this one compartment is locked behind ESA Tier-7 clearance."
  ▎ "Likely a standard security protocol for sensitive equipment. I've logged it and will continue monitoring."

  (The AI says "likely standard" but the fact that it brought it up says otherwise. Sharp players will notice.)

  Example — first_death_001:

  ▎ {{AI_NAME}}: "Systems restored. You were clinically dead for approximately 4.7 seconds. The emergency reconstruction protocol worked, which is... good, because I wasn't entirely sure it would."
  ▎ "Your cargo was jettisoned automatically on structural failure. It should still be recoverable at the wreck site — the containers are designed to survive worse than what just happened."
  ▎ "I would recommend a more conservative approach to whatever that was."

  ---
  Phase 4: Late Act I — Deepening (60+ minutes)

  Stakes rise. Foreshadowing intensifies. Personal connections deepen before they're taken away.

  ┌────────────────────┬────────────────────────┬───────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │         ID         │        Speaker         │                    Trigger                    │                                                                                      Purpose                                                                                       │
  ├────────────────────┼────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ stern_update_002   │ Dr. Stern              │ After tier-2 research completed               │ More desperate. Mentions riots. Professional composure slipping.                                                                                                                   │
  ├────────────────────┼────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ elara_003          │ Elara                  │ After stern_update_002                        │ Mentions ESA requisitioning embryonic research equipment from her university. "For the Mars program." Key foreshadowing.                                                           │
  ├────────────────────┼────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ ai_observation_001 │ {{AI_NAME}}            │ After 5+ modules crafted or major progression │ AI observes the ship is "overbuilt for a mining vessel." Mentions redundant life support, excessive radiation shielding. Doesn't draw conclusions — just notes it.                 │
  ├────────────────────┼────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ encrypted_001      │ Unknown (ESA Engineer) │ Late-game progression trigger                 │ Corrupted message fragment. Partially garbled. Questions the mission. Not all words come through.                                                                                  │
  ├────────────────────┼────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ elara_004          │ Elara                  │ Late game, before the Valkyrie Drive          │ Most personal message yet. She's scared. Admits she didn't want Nomad to go. This is the message that makes the twist hurt.                                                        │
  ├────────────────────┼────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ stern_update_003   │ Dr. Stern              │ Near Valkyrie Drive completion                │ Final pre-jump briefing. Stern is composed but exhausted. Gives final instructions about the Proxima mission. The spectral data she references is thin — sharp players may notice. │
  └────────────────────┴────────────────────────┴───────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  Example — elara_003:

  ▎ Elara: "Something weird happened at the university today. ESA showed up and requisitioned the entire embryonic biology lab. Equipment, samples, everything. They said it was for the Mars program."
  ▎ "There is no Mars program. I checked. Not officially, anyway. When I asked Professor Chen about it, he just said 'don't worry about it' in that tone people use when you should absolutely worry about it."
  ▎ "Probably nothing. Just bureaucracy. But it felt strange. Anyway, Mika says hi. She doesn't, but I'm saying she does."

  Example — encrypted_001:

  ▎ Unknown: "[SIGNAL DEGRADED] ...parameters don't... [CORRUPTED] ...the Proxima data has error margins of... [STATIC] ...they know this isn't a mining mission. The manifest weight alone... [CORRUPTED] ...if Nomad finds out before... [SIGNAL LOST]"

  (This should feel genuinely unsettling. The player can't un-read it. Partially corrupted is key — enough to raise questions, not enough to give answers.)

  Example — elara_004:

  ▎ Elara: "I had a dream about when we were kids. That time you climbed the radio tower behind the school because you wanted to see if you could see the sea from up there. You couldn't. But you stayed up there for hours anyway."
  ▎ "I think about that a lot. You were always looking at the horizon. I used to think it was bravery. Now I think maybe you were just... uncomfortable standing still."
  ▎ "I didn't want you to go. I know I said I understood. I didn't. I just didn't know how to say that."
  ▎ "Come back. I know you probably can't read these in order, or maybe at all. But come back."

  (This is the message that will destroy the player during the time dilation sequence. They'll remember Elara writing "come back" when her final message arrives decades later.)

  ---
  Exploration / Spatial Triggers

  These fire when the player approaches specific celestial bodies. They reward curiosity and build atmosphere.

  ┌──────────────────┬─────────────┬──────────────────────────────────┬──────────────────────────┐
  │        ID        │   Speaker   │             Trigger              │         Position         │
  ├──────────────────┼─────────────┼──────────────────────────────────┼──────────────────────────┤
  │ near_earth_001   │ {{AI_NAME}} │ SpatialCommsTrigger near Earth   │ ~15,000 km from Earth    │
  ├──────────────────┼─────────────┼──────────────────────────────────┼──────────────────────────┤
  │ near_luna_001    │ {{AI_NAME}} │ SpatialCommsTrigger near Luna    │ ~5,000 km from Luna      │
  ├──────────────────┼─────────────┼──────────────────────────────────┼──────────────────────────┤
  │ near_mars_001    │ {{AI_NAME}} │ SpatialCommsTrigger near Mars    │ ~10,000 km from Mars     │
  ├──────────────────┼─────────────┼──────────────────────────────────┼──────────────────────────┤
  │ near_jupiter_001 │ {{AI_NAME}} │ SpatialCommsTrigger near Jupiter │ ~100,000 km from Jupiter │
  ├──────────────────┼─────────────┼──────────────────────────────────┼──────────────────────────┤
  │ near_saturn_001  │ {{AI_NAME}} │ SpatialCommsTrigger near Saturn  │ ~80,000 km from Saturn   │
  └──────────────────┴─────────────┴──────────────────────────────────┴──────────────────────────┘

  Example — near_earth_001:

  ▎ {{AI_NAME}}: "Earth. Atmospheric spectral analysis shows elevated methane and CO2 concentrations, consistent with Ground Control's reports. The northern hemisphere cloud patterns are... atypical."
  ▎ "Current population estimate: 8.1 billion. Projected to decline within the decade at current trajectory."
  ▎ "I understand this is your home. I can adjust my reporting filters if you'd prefer less detail."

  (The AI offering to filter information is a small character moment — it's already reading Nomad's emotional state, or trying to.)

  Example — near_jupiter_001:

  ▎ {{AI_NAME}}: "Jupiter. Mass: 1.898 × 10²⁷ kilograms. 318 times Earth's mass. The Great Red Spot alone could contain two Earths."
  ▎ "There's something about this planet that makes numbers feel inadequate. I have 47 pages of telemetry data, and none of it captures what the visual sensors are showing me right now."
  ▎ "...That was an uncharacteristic observation. Disregard."

  (The AI catching itself having an aesthetic experience, then awkwardly walking it back. This is the STORY.md beat about the AI "occasionally offering unsolicited observations that hint at something more.")

  ---
  Trigger Implementation Notes

  Already supported — no code changes needed:
  - CommsStatWatcher for health thresholds, cargo full, overheat
  - SpatialCommsTrigger for celestial body approaches
  - useCommsTrigger for mining completion (already used)

  Need new trigger hooks (small code additions):
  - Research start/complete — add useCommsTrigger call in ResearchTicker or startResearchAtom
  - First craft — add trigger in addCraftedItemAtom
  - Post-respawn — add trigger in DeathScreen after respawn
  - Progression-gated messages (e.g., "after 3 researches") — CommsStatWatcher on researchAtom.completedNodes.length
  - Time-delayed personal messages — either gate on progression milestones (simpler) or add a play-time tracker

  Message ordering approach:
  Personal messages (Elara) and story beats (Stern updates, foreshadowing) should be gated on progression milestones rather than real time. This means players who progress faster get messages faster, which feels natural. A player who has completed 3 researches has "been in the game" long
  enough for Elara's first message, regardless of actual clock time.

  ---
  Priority Summary — What to Build First

  1. Improve existing 4 messages (tone/content polish)
  2. Tutorial reactive (first_damage, overheat, cargo_full) — these are quick wins with existing triggers
  3. Research milestones (research_start, research_complete, first_craft) — needs small trigger additions
  4. Elara's first two messages — the emotional core, gated on progression
  5. First death — teaches wreck system with character
  6. Stern updates + foreshadowing — mid-game story beats
  7. Spatial/exploration — celestial body observations
  8. Late-game foreshadowing (encrypted fragment, Elara embryo hint, AI manifest anomaly) — the payoff seeds


  ---


  Let's just do groups 1 to 3 for now 
  Some thoughts: 
  - leave ai_intro_001 as is 
  - overheat_001: pacing is not a thing in the game. the suggested solution should depend on the current progress of the player: If Thermal Management Basics is not researched yet, the AI should suggest that, so that the player can then craft Heat Sink Catridges, which are consumables
  that reduce the heat buildup instantly. If the Thermal Management Basics is already researched and the player has no Heat Sink Cartridges in the inventory, the AI should suggest crafting them. If the player does have at least one Heat Sink Cartridge in the inventory, the AI should
  suggest using it. In all cases, the AI should mention that the current laser overheats too fast to mine larger asteroids on its own.
  - cargo_full_001: an additional suggestion from the AI should be that cargo can always be jettisoned to make space for other things 
  - stern_update_001, ai_manifest_001, and elara_002 should all not come up directly after the trigger, but after a few minutes after the trigger happened.                                                                                                                                        
  - Never use em-dashes anywhere. The messages should not read like they were written by an LLM