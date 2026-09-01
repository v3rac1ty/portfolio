<!-- date: December 2024 -->

# UE5 Soulslike Combat System

A third-person action game built in Unreal Engine 5, over Oct 2024 - Dec 2024. 
Inspired by Elden Ring: every attack commits you to an animation, hits only land in a
specific timing window, dodges are directional, and chaining a combo means reading the next
input before the current swing finishes.

---

## Combat

Attacks and damage run through a pair of reusable actor components, `BPC_Combat` and
`BPC_Stat`, shared by both the player and the enemy rather than hand-rolled per character. A
Blueprint Interface (`BPI_Damage`) is what actually carries a hit from attacker to target, so
neither side needs to know the other's concrete class.

Hit detection is anim-notify-driven: a `Notify_Damage` event fires from inside the attack
montage itself, at the specific frame the blade should connect, rather than from a naive
per-tick overlap check running for the whole swing. That's what makes the combat feel
timing-based instead of just "click to deal damage" - whiffing or landing a hit depends on
where you are in the animation, not just whether you pressed the button.

Chain attacks run on a montage sequence (`SwordAttackCombo`) that strings multiple swings
together, so a well-timed follow-up input keeps the combo going instead of resetting to a
neutral idle after every hit.

## Movement & Dodging

Dodging is four-directional - forward, back, left, and right each have their own montage
(`Dodge_F/B/L/R`) rather than a single generic roll, so a sidestep actually reads differently
from a backstep. Locomotion outside of combat runs through an 8-directional strafe blend
space, which is what lets the character keep facing a locked-on target while moving in any
direction around it - the same "circle the boss" movement souls-likes are built around.

Targeting uses a dedicated lock-on system: an input action toggles a target lock, and a
widget-driven reticle (`WB_TargetLock` + a supporting `BP_TargetLockWidget`) tracks the
locked enemy on screen.

## Enemy AI

The boss runs on a Behavior Tree (`BT_Enemy`) driven by a Blackboard, with two custom BT
tasks: `Task_ChaseTarget` and `Task_SwordAttack`. It's a straightforward chase-then-attack
loop, but paired with the same hit-window and combo-montage system the player uses, so the
enemy telegraphs and commits to its swings the same way the player does - it's not a free hit
farm and it's not invincible either.

## Characters & Level

The player and enemy are built on top of two free Epic "Paragon" hero packs (Kwang for the
player, Grux for the boss) with IK Retargeter setups to route the project's own combat and
locomotion animations onto their skeletons instead of animating from scratch. The playable
space, `Souls_Style_Map`, is a single custom arena built from a modular ruined/desert
environment kit - pillars, arches, broken walls - with Lumen GI and Virtual Shadow Maps
enabled for lighting.

---

## Stack

Unreal Engine 5.4, Blueprints, Enhanced Input, Behavior Trees & Blackboards,
Animation Montages & Notifies, Blend Spaces, IK Retargeter, Lumen, Virtual Shadow Maps.
