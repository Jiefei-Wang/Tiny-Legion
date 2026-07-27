/* Generated from the YAML files under game-core/src/config. Do not edit directly. */
export const GAME_CONFIG = {
  "balance": {
    "battlefield": {
      "battlefield": {
        "width": 3000,
        "height": 1500,
        "groundHeightRatio": 0.4,
        "airMinZRatio": 0.07,
        "airGroundGapRatio": 0.03,
        "airTargetZToleranceRatio": 0.022
      },
      "movement": {
        "defaultMultiplier": 2
      },
      "air": {
        "holdGravity": 110,
        "dropGravity": 210,
        "dropSpeedCap": 260,
        "powerToSpeedScale": 70,
        "aircraft_acceleration_ratio": 1
      },
      "combat": {
        "groundProjectileMaxDropBelowFireY": 200,
        "salvageRefundFactor": 0.6,
        "penetrationArmorScaler": 2
      },
      "wreck": {
        "groundLifetimeSeconds": 10,
        "minInitialHpLossRatio": 0.01,
        "maxInitialHpLossRatio": 0.5
      },
      "structure": {
        "minCellSize": 18,
        "maxCellSize": 28
      },
      "separation": {
        "enabled": true,
        "overlapAllowanceRatio": 0.35,
        "positionFactor": 0.85,
        "velocityDamping": 0.55,
        "gridSize": 120,
        "spawnPlacementAttempts": 8
      }
    },
    "range": {
      "weaponRangeMultiplier": 1.5,
      "aircraftRangeBonusMax": 0,
      "projectileSpeed": 260,
      "projectileGravity": 95,
      "targetHistory": {
        "windowSeconds": 1,
        "samples": 10
      }
    },
    "commander": {
      "armyCap": {
        "base": 3,
        "skillPerAdditionalUnit": 2
      }
    },
    "economy": {
      "baseIncome": 8,
      "refineryIncome": 6,
      "garrisonUpkeep": 4
    },
    "materials": {
      "materials": {
        "basic": {
          "label": "normal steel",
          "mass": 50,
          "armor": 10,
          "hp": 100,
          "recoverPerSecond": 10,
          "color": "#66788d"
        },
        "reinforced": {
          "label": "Reinforced",
          "mass": 13,
          "armor": 1.3,
          "hp": 150,
          "recoverPerSecond": 1.9,
          "color": "#8ca3bd"
        },
        "ceramic": {
          "label": "heavy steel",
          "mass": 100,
          "armor": 15,
          "hp": 200,
          "recoverPerSecond": 20,
          "color": "#3f4b5a"
        },
        "reactive": {
          "label": "Reactive",
          "mass": 14,
          "armor": 1.55,
          "hp": 170,
          "recoverPerSecond": 1.7,
          "color": "#d0bb90"
        },
        "combined": {
          "label": "Combined Mk1",
          "mass": 12,
          "armor": 1.5,
          "hp": 165,
          "recoverPerSecond": 1.8,
          "color": "#bda9d8"
        }
      }
    },
    "units": {
      "components": {
        "control": {
          "mass": 8,
          "hpMul": 0.9,
          "gasCost": 2,
          "type": "control"
        },
        "engineS": {
          "mass": 10,
          "hpMul": 1,
          "gasCost": 6,
          "type": "engine",
          "power": 500,
          "maxSpeed": 170,
          "propulsion": {
            "platform": "ground",
            "mode": "omni"
          }
        },
        "engineM": {
          "mass": 45,
          "hpMul": 1,
          "gasCost": 9,
          "type": "engine",
          "power": 900,
          "maxSpeed": 65,
          "propulsion": {
            "platform": "ground",
            "mode": "omni"
          }
        },
        "jetEngine": {
          "mass": 14,
          "hpMul": 0.8,
          "gasCost": 10,
          "type": "engine",
          "power": 600,
          "maxSpeed": 320,
          "propulsion": {
            "platform": "air",
            "mode": "omni"
          }
        },
        "cannonLoader": {
          "mass": 8,
          "hpMul": 0.85,
          "gasCost": 3,
          "type": "loader",
          "loader": {
            "supports": [
              "bullet"
            ],
            "loadMultiplier": 0.95,
            "fastOperation": false,
            "minLoadTime": 1.15,
            "minBurstInterval": 0.5
          }
        },
        "missileLoader": {
          "mass": 7,
          "hpMul": 0.85,
          "gasCost": 3,
          "type": "loader",
          "loader": {
            "supports": [
              "missile"
            ],
            "loadMultiplier": 0.92,
            "fastOperation": true,
            "minLoadTime": 0.85,
            "minBurstInterval": 0.5
          }
        }
      }
    },
    "weapons": {
      "components": {
        "rapidGun": {
          "mass": 6,
          "hpMul": 0.9,
          "gasCost": 4,
          "type": "weapon",
          "directional": false,
          "projectileClass": "bullet",
          "projectileShape": "bullet-tracer",
          "projectileSizeRatio": 1,
          "maxLoadedAmmo": 1,
          "recoil": 1.2,
          "hitImpulse": 0.8,
          "damage": 5,
          "range": 420,
          "cooldown": 0.5,
          "hasAngleLimit": false,
          "projectileSpeed": 650,
          "projectileGravity": 20,
          "penetration": 0,
          "spreadDeg": 2.4
        },
        "heavyCannon": {
          "mass": 24,
          "hpMul": 0.9,
          "gasCost": 9,
          "type": "weapon",
          "directional": true,
          "projectileClass": "bullet",
          "projectileShape": "bullet-slug",
          "projectileSizeRatio": 1,
          "maxLoadedAmmo": 2,
          "recoil": 34,
          "hitImpulse": 38,
          "damage": 220,
          "range": 680,
          "cooldown": 4,
          "hasAngleLimit": true,
          "cwAngle": 35,
          "ccwAngle": 35,
          "projectileSpeed": 680,
          "projectileGravity": 65,
          "penetration": 250,
          "spreadDeg": 0.25
        },
        "explosiveShell": {
          "mass": 18,
          "hpMul": 0.9,
          "gasCost": 12,
          "type": "weapon",
          "directional": true,
          "projectileClass": "bullet",
          "projectileShape": "bullet-round",
          "projectileSizeRatio": 1,
          "maxLoadedAmmo": 2,
          "recoil": 14,
          "hitImpulse": 11,
          "damage": 50,
          "range": 360,
          "cooldown": 2,
          "hasAngleLimit": true,
          "cwAngle": 30,
          "ccwAngle": 30,
          "projectileSpeed": 240,
          "projectileGravity": 95,
          "penetration": 0,
          "explosive": {
            "blastRadius": 100,
            "blastDamage": 40,
            "falloffPower": 1.2
          }
        },
        "trackingMissile": {
          "mass": 14,
          "hpMul": 0.85,
          "gasCost": 11,
          "type": "weapon",
          "directional": true,
          "projectileClass": "missile",
          "projectileShape": "missile-missile",
          "projectileSizeRatio": 1,
          "maxLoadedAmmo": 2,
          "recoil": 9,
          "hitImpulse": 10,
          "damage": 48,
          "range": 470,
          "cooldown": 2.2,
          "hasAngleLimit": true,
          "cwAngle": 47.5,
          "ccwAngle": 47.5,
          "projectileSpeed": 230,
          "projectileGravity": 95,
          "penetration": 0,
          "tracking": {
            "turnRateDegPerSec": 135
          }
        },
        "precisionBeam": {
          "mass": 11,
          "hpMul": 0.85,
          "gasCost": 8,
          "type": "weapon",
          "directional": true,
          "projectileClass": "laser",
          "projectileShape": "laser-thin",
          "projectileSizeRatio": 1,
          "maxLoadedAmmo": 1,
          "recoil": 2,
          "hitImpulse": 2.5,
          "damage": 5,
          "range": 340,
          "cooldown": 0.1,
          "hasAngleLimit": true,
          "cwAngle": 52.5,
          "ccwAngle": 52.5,
          "projectileSpeed": 20000,
          "projectileGravity": 0,
          "penetration": 0
        }
      }
    },
    "campaign": {
      "buildings": {
        "refinery": {
          "name": "Gas Refinery",
          "size": "small",
          "gasCost": 90,
          "buildSeconds": 35,
          "description": "Processes local gas deposits into continuous income."
        },
        "research-lab": {
          "name": "Research Lab",
          "size": "small",
          "gasCost": 110,
          "buildSeconds": 50,
          "description": "Runs timed material and weapon research."
        },
        "workshop": {
          "name": "Workshop",
          "size": "medium",
          "gasCost": 100,
          "buildSeconds": 45,
          "description": "Maintains and fabricates selected craft designs."
        },
        "delivery-center": {
          "name": "Delivery Center",
          "size": "medium",
          "gasCost": 140,
          "buildSeconds": 60,
          "description": "Raises the number of friendly units supported in one battle."
        }
      },
      "research": {
        "reinforced": {
          "name": "Reinforced structures",
          "gasCost": 130,
          "durationSeconds": 55
        },
        "combined": {
          "name": "Combined composite",
          "gasCost": 180,
          "durationSeconds": 85
        },
        "mediumWeapons": {
          "name": "Explosive cannon",
          "gasCost": 170,
          "durationSeconds": 75
        }
      },
      "simulation": {
        "maxUpdateSeconds": 1,
        "refineryIncomePerSecond": 6,
        "baseDeliveryCapacity": 2,
        "deliveryCenterCapacity": 3
      },
      "logistics": {
        "defaultDistance": 20,
        "outpostTravelSeconds": 3,
        "minTravelSeconds": 4,
        "distanceSecondsFactor": 70,
        "minUnitSpeed": 20,
        "maxDistanceCost": 0.6,
        "distanceCostDivisor": 180
      }
    }
  },
  "ai": {
    "shooting": {
      "baseline": {
        "velocityFilterRatePerSecond": 6,
        "leadGainNear": 0.32,
        "leadGainFar": 0.82,
        "accelerationSoftCap": 180,
        "accelerationHardCap": 520,
        "accelerationMinGain": 0.35,
        "aimSlewDegreesPerSecond": 92,
        "aimDeadbandDegrees": 0.5
      },
      "ballisticSolver": {
        "minTimeSeconds": 0.08,
        "horizonRangeScale": 1.12,
        "minHorizonSeconds": 0.14,
        "maxHorizonSeconds": 30,
        "bracketSteps": 28,
        "bisectionSteps": 26,
        "speedErrorTolerance": 0.001,
        "directRangeTolerance": 1.05,
        "travelRangeTolerance": 1.08,
        "minimumDivisor": 0.001
      }
    },
    "levels": {
      "maxCertifiedLevel": 5
    },
    "arenaComparison": {
      "testArena": {
        "nodeDefense": 1.1,
        "baseHp": 1000000000
      },
      "comparison": {
        "unitsPerSide": 4,
        "battlefieldWidth": 1500,
        "battlefieldHeight": 1500,
        "groundHeight": 600,
        "maxSimSeconds": 200,
        "baseWorthUnits": 20
      }
    }
  },
  "display": {
    "battle": {
      "canvas": {
        "resolutionScale": 1
      },
      "view": {
        "minScale": 0.1,
        "maxScale": 2.4,
        "verticalPadding": 16,
        "cameraMargin": 80,
        "designerBorderMargin": 72
      }
    }
  },
  "editor": {
    "editor": {
      "grid": {
        "maxColumns": 10,
        "maxRows": 10
      },
      "displayKinds": [
        "panel",
        "stripe",
        "glass"
      ],
      "gameLoop": {
        "stepsPerSecond": 60,
        "maxFrameSeconds": 0.033,
        "minTimeScale": 0.5,
        "maxTimeScale": 5
      }
    }
  },
  "sound": {
    "battle": {
      "volume": {
        "default": 3,
        "min": 0,
        "max": 5
      },
      "samples": {
        "fire-rapid-1": "battle/fire-rapid-1.mp3",
        "fire-rapid-2": "battle/fire-rapid-2.mp3",
        "fire-heavy-1": "battle/fire-heavy-1.mp3",
        "fire-heavy-2": "battle/fire-heavy-2.mp3",
        "fire-explosive-1": "battle/fire-explosive-1.mp3",
        "fire-explosive-2": "battle/fire-explosive-2.mp3",
        "fire-tracking-1": "battle/fire-tracking-1.mp3",
        "fire-tracking-2": "battle/fire-tracking-2.mp3",
        "fire-beam-1": "battle/fire-beam-1.mp3",
        "fire-beam-2": "battle/fire-beam-2.mp3",
        "impact-light-1": "battle/impact-light-1.mp3",
        "impact-light-2": "battle/impact-light-2.mp3",
        "impact-light-3": "battle/impact-light-3.mp3",
        "impact-light-4": "battle/impact-light-4.mp3",
        "impact-heavy-1": "battle/impact-heavy-1.mp3",
        "impact-heavy-2": "battle/impact-heavy-2.mp3"
      },
      "firePools": {
        "rapid-fire": [
          "fire-rapid-1",
          "fire-rapid-2"
        ],
        "heavy-shot": [
          "fire-heavy-1",
          "fire-heavy-2"
        ],
        "explosive": [
          "fire-explosive-1",
          "fire-explosive-2"
        ],
        "tracking": [
          "fire-tracking-1",
          "fire-tracking-2"
        ],
        "beam-precision": [
          "fire-beam-1",
          "fire-beam-2"
        ]
      },
      "firePlaybackRates": {
        "rapid-fire": 1.12,
        "heavy-shot": 0.96,
        "explosive": 0.7,
        "tracking": 1,
        "beam-precision": 1.42
      },
      "spatial": {
        "maxPan": 1,
        "attenuationStart": 0.25,
        "attenuationFactor": 0.75,
        "muffleStart": 0.3,
        "muffleSpan": 1.2,
        "lowpassNearHz": 18000,
        "lowpassFarHz": 900,
        "lowpassQ": 0.7
      },
      "synth": {
        "envelopeFloor": 0.0001,
        "samplePlayback": {
          "minRate": 0.5,
          "maxRate": 2,
          "jitterBase": 0.96,
          "jitterRange": 0.08
        },
        "noiseBuffer": {
          "durationSeconds": 0.45,
          "priorMix": 0.72,
          "whiteMix": 0.28
        },
        "fire": {
          "partMaxVolume": 2,
          "strengthDamageScale": 80,
          "sampleBaseVolume": 0.13,
          "sampleStrengthVolume": 0.1,
          "fallbackBaseVolume": 0.035,
          "fallbackStrengthVolume": 0.085,
          "projectileFrequencyMax": 280,
          "projectileFrequencyScale": 0.12,
          "endingFrequencyMin": 45,
          "endingFrequencyRatio": 0.38,
          "envelopeStart": 0.8,
          "rapidNoiseFilterHz": 1500,
          "otherNoiseFilterHz": 520,
          "profiles": {
            "rapid-fire": {
              "frequency": 520,
              "duration": 0.045,
              "wave": "square",
              "noise": 0.24
            },
            "heavy-shot": {
              "frequency": 145,
              "duration": 0.16,
              "wave": "sawtooth",
              "noise": 0.5
            },
            "explosive": {
              "frequency": 105,
              "duration": 0.2,
              "wave": "sawtooth",
              "noise": 0.65
            },
            "tracking": {
              "frequency": 260,
              "duration": 0.13,
              "wave": "triangle",
              "noise": 0.36
            },
            "beam-precision": {
              "frequency": 980,
              "duration": 0.12,
              "wave": "sine",
              "noise": 0.08
            }
          }
        },
        "cannonTail": {
          "baseDuration": 0.34,
          "strengthDuration": 0.12,
          "baseVolume": 0.045,
          "strengthVolume": 0.055,
          "startFrequency": 82,
          "endFrequency": 31,
          "envelopeStart": 0.85
        },
        "impact": {
          "severityDamageScale": 140,
          "heavySamples": [
            "impact-heavy-1",
            "impact-heavy-2"
          ],
          "lightSamples": [
            "impact-light-1",
            "impact-light-2",
            "impact-light-3",
            "impact-light-4"
          ],
          "heavyBaseVolume": 0.12,
          "heavySeverityVolume": 0.16,
          "lightBaseVolume": 0.075,
          "lightSeverityVolume": 0.1,
          "baseDuration": 0.055,
          "severityDuration": 0.2,
          "baseVolume": 0.018,
          "severityVolume": 0.085,
          "armorFrequencyScale": 2.5,
          "endingFrequencyMin": 45,
          "endingFrequencyRatio": 0.22,
          "envelopeStart": 0.8,
          "profiles": {
            "rapid-fire": {
              "frequency": 920,
              "wave": "square",
              "noise": 0.45
            },
            "heavy-shot": {
              "frequency": 230,
              "wave": "sawtooth",
              "noise": 0.72
            },
            "explosive": {
              "frequency": 120,
              "wave": "sawtooth",
              "noise": 1
            },
            "tracking": {
              "frequency": 330,
              "wave": "triangle",
              "noise": 0.65
            },
            "beam-precision": {
              "frequency": 1280,
              "wave": "sine",
              "noise": 0.18
            }
          }
        },
        "explosion": {
          "minimumSeverity": 0.15,
          "intensityScale": 180,
          "baseDuration": 0.22,
          "severityDuration": 0.38,
          "baseVolume": 0.08,
          "severityVolume": 0.16,
          "lowpassBaseFrequency": 1600,
          "lowpassSeverityFrequency": 900,
          "lowpassEndFrequency": 90,
          "envelopeStart": 0.7,
          "boomStartFrequency": 95,
          "boomEndFrequency": 32
        },
        "spawn": {
          "volume": 0.038,
          "playerStartFrequency": 180,
          "enemyStartFrequency": 140,
          "airEndFrequency": 720,
          "groundEndFrequency": 410,
          "rampDuration": 0.18,
          "envelopeStart": 0.7,
          "envelopeDuration": 0.22,
          "stopDuration": 0.23
        },
        "engine": {
          "minimumMovingSpeed": 8,
          "maxAudibleUnits": 5,
          "baseVolume": 0.007,
          "speedVolume": 0.014,
          "airBaseFrequency": 72,
          "airSpeedFrequency": 90,
          "groundBaseFrequency": 38,
          "groundSpeedFrequency": 42,
          "envelopeStart": 0.55,
          "envelopeDuration": 0.2,
          "stopDuration": 0.21,
          "basePulseInterval": 0.16,
          "speedPulseInterval": 0.12
        }
      }
    }
  }
} as const;

export const GAME_CONFIG_DESCRIPTIONS = {
  "balance": {
    "battlefield": {
      "battlefield.width": "Canonical battlefield width in simulation world units.",
      "battlefield.height": "Canonical battlefield height in simulation world units.",
      "battlefield.groundHeightRatio": "Fraction of battlefield height occupied by the ground combat zone.",
      "battlefield.airMinZRatio": "Minimum air-layer altitude as a fraction of battlefield height.",
      "battlefield.airGroundGapRatio": "Vertical gap between air and ground zones as a fraction of battlefield height.",
      "battlefield.airTargetZToleranceRatio": "Allowed air-target altitude difference as a fraction of battlefield height.",
      "movement.defaultMultiplier": "Default multiplier applied to commanded unit movement speed.",
      "air.holdGravity": "Gravity acceleration applied while an air unit has enough thrust to remain operational.",
      "air.dropGravity": "Gravity acceleration applied to an air unit that can no longer sustain flight.",
      "air.dropSpeedCap": "Maximum downward speed of a falling air unit.",
      "air.powerToSpeedScale": "Conversion factor from air-engine power per unit mass to speed and lift capacity; it does not change speed by direction.",
      "air.aircraft_acceleration_ratio": "Global multiplier applied to aircraft thrust-to-mass acceleration and default deceleration.",
      "combat.groundProjectileMaxDropBelowFireY": "Downward distance below its firing point after which an upward-fired ground projectile is removed.",
      "combat.salvageRefundFactor": "Fraction of deployment gas refunded when a living player unit returns to base.",
      "combat.penetrationArmorScaler": "Armor-to-penetration-cost multiplier used before a projectile spends penetration on cell HP.",
      "wreck.groundLifetimeSeconds": "Seconds a mission-killed ground craft remains as a damageable wreck.",
      "wreck.minInitialHpLossRatio": "Minimum fraction of each surviving structure cell's HP removed when a ground wreck is created.",
      "wreck.maxInitialHpLossRatio": "Maximum fraction of each surviving structure cell's HP removed when a ground wreck is created.",
      "structure.minCellSize": "Minimum world-space size of a structure cell.",
      "structure.maxCellSize": "Maximum world-space size of a structure cell.",
      "separation.enabled": "Enables overlap resolution between active units.",
      "separation.overlapAllowanceRatio": "Fraction of unit overlap tolerated before separation correction starts.",
      "separation.positionFactor": "Fraction of detected overlap corrected through position movement each step.",
      "separation.velocityDamping": "Velocity retained while resolving an overlap.",
      "separation.gridSize": "Spatial-hash cell size used to find nearby units for separation.",
      "separation.spawnPlacementAttempts": "Maximum attempts to find a non-overlapping spawn position."
    },
    "range": {
      "weaponRangeMultiplier": "Global multiplier added to every weapon's authored targeting range.",
      "aircraftRangeBonusMax": "Maximum extra firing range granted to an air unit at the top of the air zone.",
      "projectileSpeed": "Fallback projectile speed when a weapon or part does not provide one.",
      "projectileGravity": "Fallback projectile gravity when a weapon or part does not provide one.",
      "targetHistory.windowSeconds": "Duration of target positions retained for AI motion prediction.",
      "targetHistory.samples": "Maximum number of target-position samples retained during the history window."
    },
    "commander": {
      "armyCap.base": "Number of units a commander can control without additional command skill.",
      "armyCap.skillPerAdditionalUnit": "Command skill required for each unit above the base army cap."
    },
    "economy": {
      "baseIncome": "Baseline strategic income before refinery and upkeep adjustments.",
      "refineryIncome": "Additional strategic income provided by each refinery.",
      "garrisonUpkeep": "Strategic upkeep charged for each node with a garrison."
    },
    "materials": {
      "materials.basic.label": "Display name used for this structure material.",
      "materials.basic.mass": "Mass contributed by one structure cell made from this material.",
      "materials.basic.armor": "Flat damage reduction and penetration resistance of this material.",
      "materials.basic.hp": "Maximum hit points of one structure cell made from this material.",
      "materials.basic.recoverPerSecond": "Structure HP this material can recover per second where recovery is supported.",
      "materials.basic.color": "Default hexadecimal display color for structure cells made from this material.",
      "materials.reinforced.label": "Display name used for this structure material.",
      "materials.reinforced.mass": "Mass contributed by one structure cell made from this material.",
      "materials.reinforced.armor": "Flat damage reduction and penetration resistance of this material.",
      "materials.reinforced.hp": "Maximum hit points of one structure cell made from this material.",
      "materials.reinforced.recoverPerSecond": "Structure HP this material can recover per second where recovery is supported.",
      "materials.reinforced.color": "Default hexadecimal display color for structure cells made from this material.",
      "materials.ceramic.label": "Display name used for this structure material.",
      "materials.ceramic.mass": "Mass contributed by one structure cell made from this material.",
      "materials.ceramic.armor": "Flat damage reduction and penetration resistance of this material.",
      "materials.ceramic.hp": "Maximum hit points of one structure cell made from this material.",
      "materials.ceramic.recoverPerSecond": "Structure HP this material can recover per second where recovery is supported.",
      "materials.ceramic.color": "Default hexadecimal display color for structure cells made from this material.",
      "materials.reactive.label": "Display name used for this structure material.",
      "materials.reactive.mass": "Mass contributed by one structure cell made from this material.",
      "materials.reactive.armor": "Flat damage reduction and penetration resistance of this material.",
      "materials.reactive.hp": "Maximum hit points of one structure cell made from this material.",
      "materials.reactive.recoverPerSecond": "Structure HP this material can recover per second where recovery is supported.",
      "materials.reactive.color": "Default hexadecimal display color for structure cells made from this material.",
      "materials.combined.label": "Display name used for this structure material.",
      "materials.combined.mass": "Mass contributed by one structure cell made from this material.",
      "materials.combined.armor": "Flat damage reduction and penetration resistance of this material.",
      "materials.combined.hp": "Maximum hit points of one structure cell made from this material.",
      "materials.combined.recoverPerSecond": "Structure HP this material can recover per second where recovery is supported.",
      "materials.combined.color": "Default hexadecimal display color for structure cells made from this material."
    },
    "units": {
      "components.control.mass": "Base mass contributed by this functional component.",
      "components.control.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.control.gasCost": "Gas cost contributed by this component to its craft.",
      "components.control.type": "Runtime component family used for behavior and compatibility checks.",
      "components.engineS.mass": "Base mass contributed by this functional component.",
      "components.engineS.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.engineS.gasCost": "Gas cost contributed by this component to its craft.",
      "components.engineS.type": "Runtime component family used for behavior and compatibility checks.",
      "components.engineS.power": "Engine power used in thrust-to-mass movement calculations.",
      "components.engineS.maxSpeed": "Hard movement-speed cap contributed by this engine.",
      "components.engineS.propulsion.platform": "Unit platform this engine supports, such as ground or air.",
      "components.engineS.propulsion.mode": "Directions in which this engine can provide thrust.",
      "components.engineM.mass": "Base mass contributed by this functional component.",
      "components.engineM.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.engineM.gasCost": "Gas cost contributed by this component to its craft.",
      "components.engineM.type": "Runtime component family used for behavior and compatibility checks.",
      "components.engineM.power": "Engine power used in thrust-to-mass movement calculations.",
      "components.engineM.maxSpeed": "Hard movement-speed cap contributed by this engine.",
      "components.engineM.propulsion.platform": "Unit platform this engine supports, such as ground or air.",
      "components.engineM.propulsion.mode": "Directions in which this engine can provide thrust.",
      "components.jetEngine.mass": "Base mass contributed by this functional component.",
      "components.jetEngine.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.jetEngine.gasCost": "Gas cost contributed by this component to its craft.",
      "components.jetEngine.type": "Runtime component family used for behavior and compatibility checks.",
      "components.jetEngine.power": "Engine power used in thrust-to-mass movement calculations.",
      "components.jetEngine.maxSpeed": "Hard movement-speed cap contributed by this engine.",
      "components.jetEngine.propulsion.platform": "Unit platform this engine supports, such as ground or air.",
      "components.jetEngine.propulsion.mode": "Directions in which this engine can provide thrust.",
      "components.cannonLoader.mass": "Base mass contributed by this functional component.",
      "components.cannonLoader.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.cannonLoader.gasCost": "Gas cost contributed by this component to its craft.",
      "components.cannonLoader.type": "Runtime component family used for behavior and compatibility checks.",
      "components.cannonLoader.loader.supports": "Projectile classes this loader is allowed to service.",
      "components.cannonLoader.loader.loadMultiplier": "Multiplier applied to the serviced weapon's reload duration.",
      "components.cannonLoader.loader.fastOperation": "Allows this loader to use fast-operation reload behavior.",
      "components.cannonLoader.loader.minLoadTime": "Minimum seconds required for this loader to prepare a round.",
      "components.cannonLoader.loader.minBurstInterval": "Minimum seconds between rounds released from loaded capacity.",
      "components.missileLoader.mass": "Base mass contributed by this functional component.",
      "components.missileLoader.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.missileLoader.gasCost": "Gas cost contributed by this component to its craft.",
      "components.missileLoader.type": "Runtime component family used for behavior and compatibility checks.",
      "components.missileLoader.loader.supports": "Projectile classes this loader is allowed to service.",
      "components.missileLoader.loader.loadMultiplier": "Multiplier applied to the serviced weapon's reload duration.",
      "components.missileLoader.loader.fastOperation": "Allows this loader to use fast-operation reload behavior.",
      "components.missileLoader.loader.minLoadTime": "Minimum seconds required for this loader to prepare a round.",
      "components.missileLoader.loader.minBurstInterval": "Minimum seconds between rounds released from loaded capacity."
    },
    "weapons": {
      "components.rapidGun.mass": "Base mass contributed by this weapon component.",
      "components.rapidGun.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.rapidGun.gasCost": "Gas cost contributed by this weapon to its craft.",
      "components.rapidGun.type": "Runtime component family; weapon entries must use weapon.",
      "components.rapidGun.directional": "Whether rotating the placed part also rotates its functional firing direction; this is separate from its allowed firing arc.",
      "components.rapidGun.projectileClass": "Projectile behavior family used by firing, AI, collision, and loaders.",
      "components.rapidGun.projectileShape": "Asset-backed projectile shape used by rendering and fitted collision.",
      "components.rapidGun.projectileSizeRatio": "Uniform projectile visual and collider scale multiplier.",
      "components.rapidGun.maxLoadedAmmo": "Maximum number of ready rounds the weapon can hold.",
      "components.rapidGun.recoil": "Impulse applied to the firing craft.",
      "components.rapidGun.hitImpulse": "Impulse applied to a target struck by this weapon.",
      "components.rapidGun.damage": "Direct damage delivered by one projectile or beam hit before armor.",
      "components.rapidGun.range": "Authored targeting and firing range before global range scaling.",
      "components.rapidGun.cooldown": "Minimum seconds between weapon firing attempts.",
      "components.rapidGun.hasAngleLimit": "Whether the base weapon definition limits aiming around its facing.",
      "components.rapidGun.projectileSpeed": "Initial speed of projectiles fired by this weapon.",
      "components.rapidGun.projectileGravity": "Downward acceleration applied to this weapon's projectile.",
      "components.rapidGun.penetration": "Initial penetration budget available to pass through hit parts.",
      "components.rapidGun.spreadDeg": "Maximum random angular spread applied to a shot.",
      "components.heavyCannon.mass": "Base mass contributed by this weapon component.",
      "components.heavyCannon.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.heavyCannon.gasCost": "Gas cost contributed by this weapon to its craft.",
      "components.heavyCannon.type": "Runtime component family; weapon entries must use weapon.",
      "components.heavyCannon.directional": "Whether rotating the placed part also rotates its functional firing direction; this is separate from its allowed firing arc.",
      "components.heavyCannon.projectileClass": "Projectile behavior family used by firing, AI, collision, and loaders.",
      "components.heavyCannon.projectileShape": "Asset-backed projectile shape used by rendering and fitted collision.",
      "components.heavyCannon.projectileSizeRatio": "Uniform projectile visual and collider scale multiplier.",
      "components.heavyCannon.maxLoadedAmmo": "Maximum number of ready rounds the weapon can hold.",
      "components.heavyCannon.recoil": "Impulse applied to the firing craft.",
      "components.heavyCannon.hitImpulse": "Impulse applied to a target struck by this weapon.",
      "components.heavyCannon.damage": "Direct damage delivered by one projectile or beam hit before armor.",
      "components.heavyCannon.range": "Authored targeting and firing range before global range scaling.",
      "components.heavyCannon.cooldown": "Minimum seconds between weapon firing attempts.",
      "components.heavyCannon.hasAngleLimit": "Whether the base weapon definition limits aiming around its facing.",
      "components.heavyCannon.cwAngle": "Maximum clockwise aiming angle in degrees when the base weapon angle limit is enabled.",
      "components.heavyCannon.ccwAngle": "Maximum counter-clockwise aiming angle in degrees when the base weapon angle limit is enabled.",
      "components.heavyCannon.projectileSpeed": "Initial speed of projectiles fired by this weapon.",
      "components.heavyCannon.projectileGravity": "Downward acceleration applied to this weapon's projectile.",
      "components.heavyCannon.penetration": "Initial penetration budget available to pass through hit parts.",
      "components.heavyCannon.spreadDeg": "Maximum random angular spread applied to a shot.",
      "components.explosiveShell.mass": "Base mass contributed by this weapon component.",
      "components.explosiveShell.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.explosiveShell.gasCost": "Gas cost contributed by this weapon to its craft.",
      "components.explosiveShell.type": "Runtime component family; weapon entries must use weapon.",
      "components.explosiveShell.directional": "Whether rotating the placed part also rotates its functional firing direction; this is separate from its allowed firing arc.",
      "components.explosiveShell.projectileClass": "Projectile behavior family used by firing, AI, collision, and loaders.",
      "components.explosiveShell.projectileShape": "Asset-backed projectile shape used by rendering and fitted collision.",
      "components.explosiveShell.projectileSizeRatio": "Uniform projectile visual and collider scale multiplier.",
      "components.explosiveShell.maxLoadedAmmo": "Maximum number of ready rounds the weapon can hold.",
      "components.explosiveShell.recoil": "Impulse applied to the firing craft.",
      "components.explosiveShell.hitImpulse": "Impulse applied to a target struck by this weapon.",
      "components.explosiveShell.damage": "Direct damage delivered by one projectile or beam hit before armor.",
      "components.explosiveShell.range": "Authored targeting and firing range before global range scaling.",
      "components.explosiveShell.cooldown": "Minimum seconds between weapon firing attempts.",
      "components.explosiveShell.hasAngleLimit": "Whether the base weapon definition limits aiming around its facing.",
      "components.explosiveShell.cwAngle": "Maximum clockwise aiming angle in degrees when the base weapon angle limit is enabled.",
      "components.explosiveShell.ccwAngle": "Maximum counter-clockwise aiming angle in degrees when the base weapon angle limit is enabled.",
      "components.explosiveShell.projectileSpeed": "Initial speed of projectiles fired by this weapon.",
      "components.explosiveShell.projectileGravity": "Downward acceleration applied to this weapon's projectile.",
      "components.explosiveShell.penetration": "Initial penetration budget available to pass through hit parts.",
      "components.explosiveShell.explosive.blastRadius": "World-space radius affected when this projectile explodes.",
      "components.explosiveShell.explosive.blastDamage": "Maximum splash damage at the center of the explosion.",
      "components.explosiveShell.explosive.falloffPower": "Curve exponent controlling how splash damage decreases with distance.",
      "components.trackingMissile.mass": "Base mass contributed by this weapon component.",
      "components.trackingMissile.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.trackingMissile.gasCost": "Gas cost contributed by this weapon to its craft.",
      "components.trackingMissile.type": "Runtime component family; weapon entries must use weapon.",
      "components.trackingMissile.directional": "Whether rotating the placed part also rotates its functional firing direction; this is separate from its allowed firing arc.",
      "components.trackingMissile.projectileClass": "Projectile behavior family used by firing, AI, collision, and loaders.",
      "components.trackingMissile.projectileShape": "Asset-backed projectile shape used by rendering and fitted collision.",
      "components.trackingMissile.projectileSizeRatio": "Uniform projectile visual and collider scale multiplier.",
      "components.trackingMissile.maxLoadedAmmo": "Maximum number of ready rounds the weapon can hold.",
      "components.trackingMissile.recoil": "Impulse applied to the firing craft.",
      "components.trackingMissile.hitImpulse": "Impulse applied to a target struck by this weapon.",
      "components.trackingMissile.damage": "Direct damage delivered by one projectile or beam hit before armor.",
      "components.trackingMissile.range": "Authored targeting and firing range before global range scaling.",
      "components.trackingMissile.cooldown": "Minimum seconds between weapon firing attempts.",
      "components.trackingMissile.hasAngleLimit": "Whether the base weapon definition limits aiming around its facing.",
      "components.trackingMissile.cwAngle": "Maximum clockwise aiming angle in degrees when the base weapon angle limit is enabled.",
      "components.trackingMissile.ccwAngle": "Maximum counter-clockwise aiming angle in degrees when the base weapon angle limit is enabled.",
      "components.trackingMissile.projectileSpeed": "Initial speed of projectiles fired by this weapon.",
      "components.trackingMissile.projectileGravity": "Downward acceleration applied to this weapon's projectile.",
      "components.trackingMissile.penetration": "Initial penetration budget available to pass through hit parts.",
      "components.trackingMissile.tracking.turnRateDegPerSec": "Maximum homing rotation rate of the tracking projectile.",
      "components.precisionBeam.mass": "Base mass contributed by this weapon component.",
      "components.precisionBeam.hpMul": "Legacy component durability multiplier retained by component stats and authoring compatibility.",
      "components.precisionBeam.gasCost": "Gas cost contributed by this weapon to its craft.",
      "components.precisionBeam.type": "Runtime component family; weapon entries must use weapon.",
      "components.precisionBeam.directional": "Whether rotating the placed part also rotates its functional firing direction; this is separate from its allowed firing arc.",
      "components.precisionBeam.projectileClass": "Projectile behavior family used by firing, AI, collision, and loaders.",
      "components.precisionBeam.projectileShape": "Asset-backed projectile shape used by rendering and fitted collision.",
      "components.precisionBeam.projectileSizeRatio": "Uniform projectile visual and collider scale multiplier.",
      "components.precisionBeam.maxLoadedAmmo": "Maximum number of ready rounds the weapon can hold.",
      "components.precisionBeam.recoil": "Impulse applied to the firing craft.",
      "components.precisionBeam.hitImpulse": "Impulse applied to a target struck by this weapon.",
      "components.precisionBeam.damage": "Direct damage delivered by one projectile or beam hit before armor.",
      "components.precisionBeam.range": "Authored targeting and firing range before global range scaling.",
      "components.precisionBeam.cooldown": "Minimum seconds between weapon firing attempts.",
      "components.precisionBeam.hasAngleLimit": "Whether the base weapon definition limits aiming around its facing.",
      "components.precisionBeam.cwAngle": "Maximum clockwise aiming angle in degrees when the base weapon angle limit is enabled.",
      "components.precisionBeam.ccwAngle": "Maximum counter-clockwise aiming angle in degrees when the base weapon angle limit is enabled.",
      "components.precisionBeam.projectileSpeed": "Initial speed of projectiles fired by this weapon.",
      "components.precisionBeam.projectileGravity": "Downward acceleration applied to this weapon's projectile.",
      "components.precisionBeam.penetration": "Initial penetration budget available to pass through hit parts."
    },
    "campaign": {
      "buildings.refinery.name": "Player-facing name of this base building.",
      "buildings.refinery.size": "Base construction-slot size required by this building.",
      "buildings.refinery.gasCost": "Gas spent when construction of this building is queued.",
      "buildings.refinery.buildSeconds": "Real-time seconds required to finish this building.",
      "buildings.refinery.description": "Player-facing explanation shown for this building.",
      "buildings.research-lab.name": "Player-facing name of this base building.",
      "buildings.research-lab.size": "Base construction-slot size required by this building.",
      "buildings.research-lab.gasCost": "Gas spent when construction of this building is queued.",
      "buildings.research-lab.buildSeconds": "Real-time seconds required to finish this building.",
      "buildings.research-lab.description": "Player-facing explanation shown for this building.",
      "buildings.workshop.name": "Player-facing name of this base building.",
      "buildings.workshop.size": "Base construction-slot size required by this building.",
      "buildings.workshop.gasCost": "Gas spent when construction of this building is queued.",
      "buildings.workshop.buildSeconds": "Real-time seconds required to finish this building.",
      "buildings.workshop.description": "Player-facing explanation shown for this building.",
      "buildings.delivery-center.name": "Player-facing name of this base building.",
      "buildings.delivery-center.size": "Base construction-slot size required by this building.",
      "buildings.delivery-center.gasCost": "Gas spent when construction of this building is queued.",
      "buildings.delivery-center.buildSeconds": "Real-time seconds required to finish this building.",
      "buildings.delivery-center.description": "Player-facing explanation shown for this building.",
      "research.reinforced.name": "Player-facing name of this research project.",
      "research.reinforced.gasCost": "Gas spent when this research project is started.",
      "research.reinforced.durationSeconds": "Real-time seconds required to complete this research.",
      "research.combined.name": "Player-facing name of this research project.",
      "research.combined.gasCost": "Gas spent when this research project is started.",
      "research.combined.durationSeconds": "Real-time seconds required to complete this research.",
      "research.mediumWeapons.name": "Player-facing name of this research project.",
      "research.mediumWeapons.gasCost": "Gas spent when this research project is started.",
      "research.mediumWeapons.durationSeconds": "Real-time seconds required to complete this research.",
      "simulation.maxUpdateSeconds": "Maximum campaign time step processed in one update.",
      "simulation.refineryIncomePerSecond": "Gas generated per second by each completed campaign refinery.",
      "simulation.baseDeliveryCapacity": "Friendly battle-unit capacity available without a Delivery Center.",
      "simulation.deliveryCenterCapacity": "Additional friendly battle-unit capacity provided by a Delivery Center.",
      "logistics.defaultDistance": "Fallback route distance used when no strategic-map distance is available.",
      "logistics.outpostTravelSeconds": "Fixed delivery time for craft supplied by an in-range outpost.",
      "logistics.minTravelSeconds": "Minimum travel time for a dispatched craft.",
      "logistics.distanceSecondsFactor": "Route-distance scale used to calculate dispatch travel time.",
      "logistics.minUnitSpeed": "Minimum craft speed used when calculating logistics travel time.",
      "logistics.maxDistanceCost": "Maximum additional gas-cost fraction caused by route distance.",
      "logistics.distanceCostDivisor": "Route distance that produces one full unit of distance cost before capping."
    }
  },
  "ai": {
    "shooting": {
      "baseline.velocityFilterRatePerSecond": "Rate used to smooth observed target velocity; higher values follow changes faster.",
      "baseline.leadGainNear": "Fraction of predicted target lead applied at close range.",
      "baseline.leadGainFar": "Fraction of predicted target lead applied at long range.",
      "baseline.accelerationSoftCap": "Target acceleration where lead prediction begins to be reduced.",
      "baseline.accelerationHardCap": "Target acceleration treated as too erratic for full lead prediction.",
      "baseline.accelerationMinGain": "Minimum lead multiplier retained for highly accelerating targets.",
      "baseline.aimSlewDegreesPerSecond": "Maximum rate at which baseline AI aim may rotate.",
      "baseline.aimDeadbandDegrees": "Angular change ignored by baseline aim to prevent visual and firing jitter.",
      "ballisticSolver.minTimeSeconds": "Earliest projectile flight time considered by the ballistic solver.",
      "ballisticSolver.horizonRangeScale": "Multiplier applied to estimated range when choosing the solve horizon.",
      "ballisticSolver.minHorizonSeconds": "Minimum flight-time horizon searched for a ballistic solution.",
      "ballisticSolver.maxHorizonSeconds": "Maximum flight-time horizon searched for a ballistic solution.",
      "ballisticSolver.bracketSteps": "Number of coarse time samples used to bracket a ballistic solution.",
      "ballisticSolver.bisectionSteps": "Number of refinement iterations applied after a solution is bracketed.",
      "ballisticSolver.speedErrorTolerance": "Accepted difference between required and available launch speed.",
      "ballisticSolver.directRangeTolerance": "Range allowance used when accepting a direct-fire solution.",
      "ballisticSolver.travelRangeTolerance": "Range allowance used when accepting an arcing travel solution.",
      "ballisticSolver.minimumDivisor": "Small positive floor used to prevent unstable division."
    },
    "levels": {
      "maxCertifiedLevel": "Highest built-in AI skill level exposed by certified level selectors."
    },
    "arenaComparison": {
      "testArena.nodeDefense": "Default Test Arena node defense multiplier shared by browser and headless AI comparison.",
      "testArena.baseHp": "Default HP assigned to both Test Arena bases and headless AI comparison bases.",
      "comparison.unitsPerSide": "Target number of live craft maintained for each side during a headless AI comparison.",
      "comparison.battlefieldWidth": "Logical battlefield width used only by headless AI comparisons and leaderboard matches.",
      "comparison.battlefieldHeight": "Logical battlefield height used only by headless AI comparisons and leaderboard matches.",
      "comparison.groundHeight": "Ground-zone height used only by headless AI comparisons and leaderboard matches.",
      "comparison.maxSimSeconds": "Game-time duration in seconds of each headless AI comparison.",
      "comparison.baseWorthUnits": "Number of destroyed craft credited for destroying the opposing base."
    }
  },
  "display": {
    "battle": {
      "canvas.resolutionScale": "Pixel-density multiplier for the viewport-sized battle render canvas, independent of logical battlefield dimensions.",
      "view.minScale": "Smallest camera zoom scale allowed in battle views.",
      "view.maxScale": "Largest camera zoom scale allowed in battle views.",
      "view.verticalPadding": "Vertical screen padding reserved when fitting the battlefield view.",
      "view.cameraMargin": "World-space margin retained around the battlefield during camera fitting.",
      "view.designerBorderMargin": "Screen-space border kept around Craft and Part Designer grid content."
    }
  },
  "editor": {
    "editor": {
      "grid.maxColumns": "Maximum number of columns allowed in Craft and Part Designer grids.",
      "grid.maxRows": "Maximum number of rows allowed in Craft and Part Designer grids.",
      "displayKinds": "Allowed visual attachment kinds available to the Display layer editor.",
      "gameLoop.stepsPerSecond": "Fixed simulation updates processed per real-time second.",
      "gameLoop.maxFrameSeconds": "Maximum real-time duration accepted from one rendered frame.",
      "gameLoop.minTimeScale": "Slowest simulation time scale accepted by the game loop.",
      "gameLoop.maxTimeScale": "Fastest simulation time scale accepted by the game loop."
    }
  },
  "sound": {
    "battle": {
      "volume.default": "Default global multiplier applied to battle sound effects.",
      "volume.min": "Lowest global battle-sound multiplier accepted by validation and developer controls.",
      "volume.max": "Highest global battle-sound multiplier accepted by validation and developer controls.",
      "samples.fire-rapid-1": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-rapid-2": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-heavy-1": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-heavy-2": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-explosive-1": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-explosive-2": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-tracking-1": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-tracking-2": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-beam-1": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.fire-beam-2": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.impact-light-1": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.impact-light-2": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.impact-light-3": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.impact-light-4": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.impact-heavy-1": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "samples.impact-heavy-2": "Audio path relative to game-core/assets/audio for this recorded sample key.",
      "firePools.rapid-fire": "Recorded sample keys randomly selected for this weapon class.",
      "firePools.heavy-shot": "Recorded sample keys randomly selected for this weapon class.",
      "firePools.explosive": "Recorded sample keys randomly selected for this weapon class.",
      "firePools.tracking": "Recorded sample keys randomly selected for this weapon class.",
      "firePools.beam-precision": "Recorded sample keys randomly selected for this weapon class.",
      "firePlaybackRates.rapid-fire": "Base playback-rate multiplier for recorded fire samples of this weapon class.",
      "firePlaybackRates.heavy-shot": "Base playback-rate multiplier for recorded fire samples of this weapon class.",
      "firePlaybackRates.explosive": "Base playback-rate multiplier for recorded fire samples of this weapon class.",
      "firePlaybackRates.tracking": "Base playback-rate multiplier for recorded fire samples of this weapon class.",
      "firePlaybackRates.beam-precision": "Base playback-rate multiplier for recorded fire samples of this weapon class.",
      "spatial.maxPan": "Maximum absolute stereo-pan value for spatial weapon audio.",
      "spatial.attenuationStart": "Listener-distance ratio where weapon volume attenuation begins.",
      "spatial.attenuationFactor": "Strength of weapon volume reduction beyond the attenuation start.",
      "spatial.muffleStart": "Listener-distance ratio where the weapon low-pass effect begins.",
      "spatial.muffleSpan": "Distance-ratio span across which weapon audio reaches maximum muffling.",
      "spatial.lowpassNearHz": "Low-pass cutoff frequency for nearby weapon sounds.",
      "spatial.lowpassFarHz": "Low-pass cutoff frequency for the most distant weapon sounds.",
      "spatial.lowpassQ": "Resonance value of the spatial low-pass filter.",
      "synth.envelopeFloor": "Small positive gain used as the silent endpoint of synthesized envelopes.",
      "synth.samplePlayback.minRate": "Lowest playback rate allowed after sample profile and random variation.",
      "synth.samplePlayback.maxRate": "Highest playback rate allowed after sample profile and random variation.",
      "synth.samplePlayback.jitterBase": "Lowest random playback-rate multiplier applied to a recorded sample.",
      "synth.samplePlayback.jitterRange": "Width of the random playback-rate variation applied to a recorded sample.",
      "synth.noiseBuffer.durationSeconds": "Duration of the reusable synthesized noise buffer.",
      "synth.noiseBuffer.priorMix": "Feedback contribution from the preceding noise sample.",
      "synth.noiseBuffer.whiteMix": "Fresh random-noise contribution for each buffer sample.",
      "synth.fire.partMaxVolume": "Maximum per-part fire-sound multiplier accepted by the renderer.",
      "synth.fire.strengthDamageScale": "Damage value used to normalize weapon-fire sound strength.",
      "synth.fire.sampleBaseVolume": "Base gain applied to recorded weapon-fire samples.",
      "synth.fire.sampleStrengthVolume": "Additional recorded-sample gain supplied at maximum fire strength.",
      "synth.fire.fallbackBaseVolume": "Base gain of synthesized weapon-fire fallback audio.",
      "synth.fire.fallbackStrengthVolume": "Additional synthesized fallback gain supplied at maximum fire strength.",
      "synth.fire.projectileFrequencyMax": "Maximum projectile speed contribution to synthesized fire pitch.",
      "synth.fire.projectileFrequencyScale": "Scale converting projectile speed into synthesized fire pitch.",
      "synth.fire.endingFrequencyMin": "Minimum ending frequency of the synthesized weapon-fire tone.",
      "synth.fire.endingFrequencyRatio": "Fraction of starting pitch used as the synthesized fire ending pitch.",
      "synth.fire.envelopeStart": "Initial gain multiplier of the synthesized weapon-fire envelope.",
      "synth.fire.rapidNoiseFilterHz": "Noise-filter cutoff frequency used for rapid-fire fallback audio.",
      "synth.fire.otherNoiseFilterHz": "Noise-filter cutoff frequency used for other weapon fallback audio.",
      "synth.fire.profiles.rapid-fire.frequency": "Base oscillator frequency for this weapon class's synthesized fire profile.",
      "synth.fire.profiles.rapid-fire.duration": "Duration in seconds of this weapon class's synthesized fire profile.",
      "synth.fire.profiles.rapid-fire.wave": "Oscillator waveform used by this weapon class's synthesized fire profile.",
      "synth.fire.profiles.rapid-fire.noise": "Noise amount mixed into this weapon class's synthesized fire profile.",
      "synth.fire.profiles.heavy-shot.frequency": "Base oscillator frequency for this weapon class's synthesized fire profile.",
      "synth.fire.profiles.heavy-shot.duration": "Duration in seconds of this weapon class's synthesized fire profile.",
      "synth.fire.profiles.heavy-shot.wave": "Oscillator waveform used by this weapon class's synthesized fire profile.",
      "synth.fire.profiles.heavy-shot.noise": "Noise amount mixed into this weapon class's synthesized fire profile.",
      "synth.fire.profiles.explosive.frequency": "Base oscillator frequency for this weapon class's synthesized fire profile.",
      "synth.fire.profiles.explosive.duration": "Duration in seconds of this weapon class's synthesized fire profile.",
      "synth.fire.profiles.explosive.wave": "Oscillator waveform used by this weapon class's synthesized fire profile.",
      "synth.fire.profiles.explosive.noise": "Noise amount mixed into this weapon class's synthesized fire profile.",
      "synth.fire.profiles.tracking.frequency": "Base oscillator frequency for this weapon class's synthesized fire profile.",
      "synth.fire.profiles.tracking.duration": "Duration in seconds of this weapon class's synthesized fire profile.",
      "synth.fire.profiles.tracking.wave": "Oscillator waveform used by this weapon class's synthesized fire profile.",
      "synth.fire.profiles.tracking.noise": "Noise amount mixed into this weapon class's synthesized fire profile.",
      "synth.fire.profiles.beam-precision.frequency": "Base oscillator frequency for this weapon class's synthesized fire profile.",
      "synth.fire.profiles.beam-precision.duration": "Duration in seconds of this weapon class's synthesized fire profile.",
      "synth.fire.profiles.beam-precision.wave": "Oscillator waveform used by this weapon class's synthesized fire profile.",
      "synth.fire.profiles.beam-precision.noise": "Noise amount mixed into this weapon class's synthesized fire profile.",
      "synth.cannonTail.baseDuration": "Base duration of the heavy-cannon low-frequency recoil tail.",
      "synth.cannonTail.strengthDuration": "Additional cannon-tail duration supplied at maximum fire strength.",
      "synth.cannonTail.baseVolume": "Base gain of the heavy-cannon recoil tail.",
      "synth.cannonTail.strengthVolume": "Additional cannon-tail gain supplied at maximum fire strength.",
      "synth.cannonTail.startFrequency": "Starting oscillator frequency of the heavy-cannon recoil tail.",
      "synth.cannonTail.endFrequency": "Ending oscillator frequency of the heavy-cannon recoil tail.",
      "synth.cannonTail.envelopeStart": "Initial gain multiplier of the cannon-tail envelope.",
      "synth.impact.severityDamageScale": "Delivered damage used to normalize impact severity.",
      "synth.impact.heavySamples": "Recorded sample keys available for heavy projectile impacts.",
      "synth.impact.lightSamples": "Recorded sample keys available for light projectile impacts.",
      "synth.impact.heavyBaseVolume": "Base recorded-sample gain for heavy impacts.",
      "synth.impact.heavySeverityVolume": "Additional heavy-impact sample gain supplied at maximum severity.",
      "synth.impact.lightBaseVolume": "Base recorded-sample gain for light impacts.",
      "synth.impact.lightSeverityVolume": "Additional light-impact sample gain supplied at maximum severity.",
      "synth.impact.baseDuration": "Base duration of synthesized impact fallback audio.",
      "synth.impact.severityDuration": "Additional synthesized impact duration supplied at maximum severity.",
      "synth.impact.baseVolume": "Base gain of synthesized impact fallback audio.",
      "synth.impact.severityVolume": "Additional synthesized impact gain supplied at maximum severity.",
      "synth.impact.armorFrequencyScale": "Scale converting struck armor into synthesized impact pitch.",
      "synth.impact.endingFrequencyMin": "Minimum ending frequency of the synthesized impact tone.",
      "synth.impact.endingFrequencyRatio": "Fraction of starting pitch used as the synthesized impact ending pitch.",
      "synth.impact.envelopeStart": "Initial gain multiplier of the synthesized impact envelope.",
      "synth.impact.profiles.rapid-fire.frequency": "Base oscillator frequency for this projectile class's impact profile.",
      "synth.impact.profiles.rapid-fire.wave": "Oscillator waveform used by this projectile class's impact profile.",
      "synth.impact.profiles.rapid-fire.noise": "Noise amount mixed into this projectile class's impact profile.",
      "synth.impact.profiles.heavy-shot.frequency": "Base oscillator frequency for this projectile class's impact profile.",
      "synth.impact.profiles.heavy-shot.wave": "Oscillator waveform used by this projectile class's impact profile.",
      "synth.impact.profiles.heavy-shot.noise": "Noise amount mixed into this projectile class's impact profile.",
      "synth.impact.profiles.explosive.frequency": "Base oscillator frequency for this projectile class's impact profile.",
      "synth.impact.profiles.explosive.wave": "Oscillator waveform used by this projectile class's impact profile.",
      "synth.impact.profiles.explosive.noise": "Noise amount mixed into this projectile class's impact profile.",
      "synth.impact.profiles.tracking.frequency": "Base oscillator frequency for this projectile class's impact profile.",
      "synth.impact.profiles.tracking.wave": "Oscillator waveform used by this projectile class's impact profile.",
      "synth.impact.profiles.tracking.noise": "Noise amount mixed into this projectile class's impact profile.",
      "synth.impact.profiles.beam-precision.frequency": "Base oscillator frequency for this projectile class's impact profile.",
      "synth.impact.profiles.beam-precision.wave": "Oscillator waveform used by this projectile class's impact profile.",
      "synth.impact.profiles.beam-precision.noise": "Noise amount mixed into this projectile class's impact profile.",
      "synth.explosion.minimumSeverity": "Minimum normalized severity used for an explosion sound.",
      "synth.explosion.intensityScale": "Explosion intensity used to normalize sound severity.",
      "synth.explosion.baseDuration": "Base duration of synthesized explosion audio.",
      "synth.explosion.severityDuration": "Additional explosion duration supplied at maximum severity.",
      "synth.explosion.baseVolume": "Base gain of synthesized explosion audio.",
      "synth.explosion.severityVolume": "Additional explosion gain supplied at maximum severity.",
      "synth.explosion.lowpassBaseFrequency": "Base low-pass cutoff of the explosion noise layer.",
      "synth.explosion.lowpassSeverityFrequency": "Additional low-pass cutoff supplied at maximum severity.",
      "synth.explosion.lowpassEndFrequency": "Ending low-pass cutoff of the explosion noise layer.",
      "synth.explosion.envelopeStart": "Initial gain multiplier of the explosion noise envelope.",
      "synth.explosion.boomStartFrequency": "Starting oscillator frequency of the explosion boom.",
      "synth.explosion.boomEndFrequency": "Ending oscillator frequency of the explosion boom.",
      "synth.spawn.volume": "Gain of synthesized unit-deployment audio.",
      "synth.spawn.playerStartFrequency": "Starting deployment tone frequency for player units.",
      "synth.spawn.enemyStartFrequency": "Starting deployment tone frequency for enemy units.",
      "synth.spawn.airEndFrequency": "Ending deployment tone frequency for air units.",
      "synth.spawn.groundEndFrequency": "Ending deployment tone frequency for ground units.",
      "synth.spawn.rampDuration": "Seconds taken for the deployment tone to reach its ending frequency.",
      "synth.spawn.envelopeStart": "Initial gain multiplier of the deployment envelope.",
      "synth.spawn.envelopeDuration": "Seconds taken for deployment gain to fade to the envelope floor.",
      "synth.spawn.stopDuration": "Seconds after start when deployment audio nodes are stopped.",
      "synth.engine.minimumMovingSpeed": "Unit speed below which no movement-engine pulse is played.",
      "synth.engine.maxAudibleUnits": "Maximum moving units that may emit engine pulses in one update.",
      "synth.engine.baseVolume": "Base gain of synthesized engine pulses.",
      "synth.engine.speedVolume": "Additional engine-pulse gain supplied at maximum normalized speed.",
      "synth.engine.airBaseFrequency": "Base engine frequency for an air unit.",
      "synth.engine.airSpeedFrequency": "Additional air-engine frequency supplied at maximum normalized speed.",
      "synth.engine.groundBaseFrequency": "Base engine frequency for a ground unit.",
      "synth.engine.groundSpeedFrequency": "Additional ground-engine frequency supplied at maximum normalized speed.",
      "synth.engine.envelopeStart": "Initial gain multiplier of an engine pulse.",
      "synth.engine.envelopeDuration": "Seconds taken for an engine pulse to fade to the envelope floor.",
      "synth.engine.stopDuration": "Seconds after start when engine-pulse audio nodes are stopped.",
      "synth.engine.basePulseInterval": "Slowest interval in seconds between engine pulses.",
      "synth.engine.speedPulseInterval": "Interval reduction supplied at maximum normalized speed."
    }
  }
} as const;

export type GameConfig = typeof GAME_CONFIG;
export type GameConfigDescriptions = typeof GAME_CONFIG_DESCRIPTIONS;
