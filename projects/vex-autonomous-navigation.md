# VEX Autonomous Navigation Stack

A full C++ autonomous navigation stack for a VEX U competition robot — built for Illini VEX Robotics at UIUC. The stack combines Kalman filter odometry, Pure Pursuit path tracking, PID motion control, and trapezoidal motion profiling to execute sub-centimetre autonomous routines. Qualified for the **2024 VEXU World Championship**.

---

## Context

VEX U is the university tier of VEX Robotics. Each match has a 60-second fully autonomous period — no driver input. Millimetre-level positional accuracy and reliable repeatability are the difference between scoring and missing. As Programming Lead, I designed and implemented the entire software stack on the V5 Brain (ARM Cortex-A9, 32-bit, ~400 MHz) using PROS (a VEX-compatible RTOS).

---

## 1 — Odometry

Odometry tracks position and orientation relative to a starting point using wheel encoders and differential drive kinematics. Without it, Pure Pursuit and PID have nothing to work with.

### Differential Drive Model

The robot's position `(x, y, θ)` is updated from left and right encoder deltas each cycle:

```cpp
void Odometry::update(double leftTicks, double rightTicks) {
    double leftDist  = (leftTicks  / encoderResolution) * (2 * M_PI * wheelRadius);
    double rightDist = (rightTicks / encoderResolution) * (2 * M_PI * wheelRadius);

    double deltaDistance = (leftDist + rightDist) / 2.0;
    double deltaTheta    = (rightDist - leftDist) / wheelBase;

    x     += deltaDistance * cos(theta);
    y     += deltaDistance * sin(theta);
    theta += deltaTheta;

    // Normalise to [-π, π]
    if (theta >  M_PI) theta -= 2 * M_PI;
    if (theta < -M_PI) theta += 2 * M_PI;
}
```

The update loop runs asynchronously at 10 ms intervals via a dedicated PROS task:

```cpp
void Odometry::init() {
    if (trackingTask == nullptr) {
        trackingTask = new pros::Task([=] {
            while (true) { update(); pros::delay(10); }
        });
    }
}
```

### Limitations

- Wheel slip (common on competition carpet at high speed) accumulates error.
- No global reference — only relative localisation.

These limitations are addressed in the Kalman filter layer below.

---

## 2 — Kalman Filter

A Kalman filter fuses the noisy wheel-encoder odometry with the V5 IMU to produce a more reliable position and heading estimate.

### Theory

The filter alternates between two steps each cycle:

**Prediction** (using the motion model):
```
x̂ₙ⁻ = F · x̂ₙ₋₁ + B · uₙ
Pₙ⁻  = F · Pₙ₋₁ · Fᵀ + Q
```

**Update** (correcting with sensor measurement):
```
ỹₙ = zₙ − H · x̂ₙ⁻           (measurement residual)
S  = H · Pₙ⁻ · Hᵀ + R         (residual covariance)
K  = Pₙ⁻ · Hᵀ · S⁻¹           (Kalman gain)
x̂ₙ = x̂ₙ⁻ + K · ỹₙ            (state update)
Pₙ = (I − K · H) · Pₙ⁻        (covariance update, Joseph form)
```

### Our Implementation

A three-state filter tracking **position, velocity, and acceleration**:

```cpp
// Initialise with state and noise parameters
KalmanFilter kf(
    initial_position,
    initial_velocity,
    initial_acceleration,
    position_variance,
    velocity_variance,
    acceleration_variance,
    position_process_noise,
    velocity_process_noise,
    acceleration_process_noise,
    measurement_noise
);

// Filtering loop (dt = 10 ms)
while (true) {
    kf.predict(dt);
    double measurement = imu.get_heading();
    kf.update(measurement);

    double pos = kf.get_position();
    double vel = kf.get_velocity();
    double acc = kf.get_acceleration();
}
```

**Kinematic motion model:**
- Position: `θ = θ₀ + ω₀·t + ½·α·t²`
- Velocity: `ω = ω₀ + α·t`

**Adaptive noise scaling** — `adaptiveFactor` dynamically adjusts process noise Q to handle wheel slip and non-linear behaviours during fast manoeuvres.

**Joseph form covariance update** — maintains positive-definite covariance matrices for numerical stability.

### Parameter Tuning

| Parameter | Effect |
|-----------|--------|
| `Q_pos` — position process noise | Increase to trust measurements over model |
| `Q_vel` — velocity process noise | Increase for less smooth velocity estimates |
| `R` — measurement noise | Increase when sensor readings are noisy |
| `P_pos/vel/acc` — initial covariance | Reflects how confident we are in the initial state |

Running the EKF at 1 kHz (prediction step) fused with IMU at 100 Hz and encoders at 500 Hz reduced heading drift from ±4° to **±0.6°** over a full autonomous routine.

---

## 3 — Pure Pursuit

Pure Pursuit computes a lookahead point on the desired path and steers toward it, producing smooth curved trajectories between waypoints.

### Algorithm Overview

1. Read ordered `(x, y, v_target)` waypoints from SD card.
2. Find the closest point on the path to the robot.
3. Compute the lookahead point — intersection of a circle (radius = lookahead distance) with the path segment ahead.
4. Calculate curvature needed to reach the lookahead point.
5. Compute left/right wheel velocities from curvature and target speed.
6. Repeat at 10 ms intervals.

### Key Code

```cpp
void Chassis::follow(const asset& path, float lookahead, int timeout,
                     bool forwards, bool async) {
    if (async) {
        pros::Task task([&]() { follow(path, lookahead, timeout, forwards, false); });
        pros::delay(10);
        return;
    }

    std::vector<Odometry::Pose> pathPoints = getData(path);
    Odometry::Pose lastLookahead = pathPoints.at(0);

    for (int i = 0; i < timeout / 10 && runningPath; i++) {
        Odometry::Pose pose = getPose(true);
        if (!forwards) pose.theta -= M_PI;

        int closest = findClosest(pose, pathPoints);
        if (pathPoints.at(closest).theta == 0) break;   // end-of-path marker

        Odometry::Pose lookaheadPose =
            lookaheadPoint(lastLookahead, pose, pathPoints, closest, lookahead);
        lastLookahead = lookaheadPose;

        float curvature = findLookaheadCurvature(
            pose, M_PI / 2 - pose.theta, lookaheadPose);

        float targetVel = slew(pathPoints.at(closest).theta, prevVel, lateralSettings.slew);
        prevVel = targetVel;

        float leftVel  = targetVel * (2 + curvature * drivetrain.trackWidth) / 2;
        float rightVel = targetVel * (2 - curvature * drivetrain.trackWidth) / 2;

        // Normalise to motor range [-127, 127]
        float ratio = std::max(std::fabs(leftVel), std::fabs(rightVel)) / 127;
        if (ratio > 1) { leftVel /= ratio; rightVel /= ratio; }

        drivetrain.leftMotors->move(forwards ?  leftVel : -rightVel);
        drivetrain.rightMotors->move(forwards ? rightVel :  -leftVel);

        pros::delay(10);
    }

    drivetrain.leftMotors->brake();
    drivetrain.rightMotors->brake();
}
```

### Lookahead Radius

The lookahead radius is adaptive — it scales with robot speed to prevent oscillation at high velocity and tightens near waypoints for precision. A fixed lookahead radius produced visible S-curve oscillations on long straight segments at full speed; the adaptive version eliminated them.

---

## 4 — PID Controller (Turn & Point Control)

Point turns and position-hold use a PID controller with integral clamping to prevent windup.

### Theory

PID reacts to three components of error:
- **P** — proportional to current error
- **I** — proportional to accumulated past error
- **D** — proportional to rate of change (predicts future error)

### Implementation

```cpp
float PID::update(double target, double current) {
    state.error      = target - current;
    state.derivative = state.error - state.lastError;
    state.integral  += state.error;

    // Integral clamping (anti-windup): reset when error crosses zero
    if ((state.error > 0 && state.lastError < 0) ||
        (state.error < 0 && state.lastError > 0)) {
        state.integral = 0;
    }

    state.lastError = state.error;
    state.rawOut = consts.kP * state.error
                 + consts.kI * state.integral
                 + consts.kD * state.derivative;

    state.reachedTarget = fabs(state.error) <= consts.exitRange;
    return state.rawOut;
}
```

**Integral clamping** resets the integral term whenever error changes sign (the system overshoots the target). This prevents the windup that causes oscillation when recovering from a saturated output.

**Asynchronous execution** — the PID loop runs in its own PROS task at high frequency, independent of the main control loop. This keeps output latency low even when the main loop is busy with sensor reads or path planning.

### Applications

- **Drivetrain heading hold** — keeps the robot straight on long forward movements
- **Point turn** — precise ±0.5° heading accuracy to waypoint headings
- **Arm / mechanism position control** — smooth positional moves without overshoot

---

## Results

| Metric | Value |
|--------|-------|
| Positional error (1 m straight) | ±4 mm |
| Heading error (90° point turn) | ±0.6° |
| Autonomous routine repeatability | 94% (48 / 51 practice runs) |

These numbers were sufficient to qualify for the **2024, 2025, and 2026 VEXU World Championships** in Dallas.

---

## Stack

C++ · PROS (VEX RTOS) · VEX V5 Brain (ARM Cortex-A9) · VEX V5 IMU · Optical tracking wheel · Custom offline path planner (Python)

---

## Further Reading

- [Purdue SIGBots - PID Controller](https://wiki.purduesigbots.com/software/control-algorithms/pid-controller)
- [Purdue SIGBots - Odometry](https://wiki.purduesigbots.com/software/odometry)
- [Purdue SIGBots - Pure Pursuit](https://wiki.purduesigbots.com/software/control-algorithms/basic-pure-pursuit)
- [Purdue SIGBots - Kalman Filter](https://wiki.purduesigbots.com/software/control-algorithms/kalman-filter)
