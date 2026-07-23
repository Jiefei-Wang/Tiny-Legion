/* Generated from the YAML files under game-core/src/config. Do not edit directly. */
export const GAME_CONFIG = {
  "balance": {
    "battlefield": {
      "battlefield": {
        "width": 2000,
        "height": 1000,
        "groundHeightRatio": 0.4,
        "airMinZRatio": 0.07,
        "airGroundGapRatio": 0.03,
        "airTargetZToleranceRatio": 0.022
      },
      "movement": {
        "defaultMultiplier": 2,
        "minMultiplier": 0.1,
        "maxMultiplier": 10
      },
      "air": {
        "holdGravity": 110,
        "dropGravity": 210,
        "dropSpeedCap": 260,
        "thrustAccelScale": 70
      },
      "combat": {
        "groundProjectileMaxDropBelowFireY": 200,
        "salvageRefundFactor": 0.6,
        "impulseDamageStressFactor": 2.2,
        "penetrationArmorScaler": 2
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
      "groundFireYTolerance": 92,
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
              "heavy-shot",
              "explosive"
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
              "tracking"
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
          "weaponClass": "rapid-fire",
          "maxLoadedAmmo": 1,
          "recoil": 1.2,
          "hitImpulse": 0.8,
          "damage": 5,
          "range": 420,
          "cooldown": 0.5,
          "shootAngleDeg": 360,
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
          "weaponClass": "heavy-shot",
          "maxLoadedAmmo": 2,
          "recoil": 34,
          "hitImpulse": 38,
          "damage": 220,
          "range": 680,
          "cooldown": 4,
          "shootAngleDeg": 70,
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
          "weaponClass": "explosive",
          "maxLoadedAmmo": 2,
          "recoil": 14,
          "hitImpulse": 11,
          "damage": 50,
          "range": 360,
          "cooldown": 2,
          "shootAngleDeg": 60,
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
          "weaponClass": "tracking",
          "maxLoadedAmmo": 2,
          "recoil": 9,
          "hitImpulse": 10,
          "damage": 48,
          "range": 470,
          "cooldown": 2.2,
          "shootAngleDeg": 95,
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
          "weaponClass": "beam-precision",
          "maxLoadedAmmo": 1,
          "recoil": 2,
          "hitImpulse": 2.5,
          "damage": 5,
          "range": 340,
          "cooldown": 0.1,
          "shootAngleDeg": 105,
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
        "maxHorizonSeconds": 6,
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
    }
  },
  "display": {
    "battle": {
      "view": {
        "minScale": 0.1,
        "maxScale": 2.4,
        "verticalPadding": 16,
        "cameraMargin": 80,
        "designerBorderMargin": 72
      },
      "renderer": {
        "statusX": 16,
        "statusY": 14,
        "statusDepth": 1000
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

export type GameConfig = typeof GAME_CONFIG;
