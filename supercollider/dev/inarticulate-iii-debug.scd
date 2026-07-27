(
// ============================================================
// Inarticulate III
// SuperCollider development/debug bridge
//
// Node.js
//     ↓ OSC
// sclang / OSCdef
//     ↓
// SynthDef
//     ↓
// scsynth
//
// 当前版本：
//
// xN       → 声相
// yN       → 音量
// pN-pM   → 对应两个声部之间的 FM 强度
// pNamp    → 不再参与声音控制
// x/y 移动速度 → Doppler 频率偏移
// ============================================================


// ------------------------------------------------------------
// 清理之前执行过的旧版本
// ------------------------------------------------------------

if(~pnds.notNil) {
    if(~pnds[\cleanup].notNil) {
        ~pnds[\cleanup].value;
    };
};


// ------------------------------------------------------------
// 初始化全局运行状态
// ------------------------------------------------------------

~pnds = ();

Server.default = s;


// ------------------------------------------------------------
// 数值工具
// ------------------------------------------------------------

~pnds[\unit] = { |value, fallback = 0.0|
    if(value.isNil) {
        fallback;
    } {
        value.asFloat.clip(0.0, 1.0);
    };
};


// ------------------------------------------------------------
// 全局参数
// ------------------------------------------------------------

// 三个基础频率
~pnds[\baseFreq1] = 500.0;
~pnds[\baseFreq2] = 1000.0;
~pnds[\baseFreq3] = 1500.0;


// x/y 的平滑时间
//
// 这里的 x/y 是 OSC 发送的离散目标值。
// SynthDef 内部通过 Lag.kr 将其转换为平滑的控制信号。
~pnds[\positionLag] = 0.12;


// 连接线强度的平滑时间
//
// 网络中的 lineStroke 是阶梯状控制信号，
// 这里将连接线强度平滑后再进入 FM 网络。
~pnds[\couplingLag] = 0.12;


// Doppler 速度的平滑时间
~pnds[\dopplerLag] = 0.18;


// Gate 的平滑时间
~pnds[\gateLag] = 0.03;


// 归一化画布单位每秒的参考速度。
//
// 速度达到这个值时，Doppler 映射达到最大值。
// 数值越大，同样的屏幕移动产生的 Doppler 越小。
~pnds[\motionReferenceSpeed] = 8.0;


// 速度死区。
//
// 低于这个速度的运动会被过滤，
// 用来避免手指轻微抖动造成 Doppler。
~pnds[\motionDeadzone] = 0.04;


// Doppler 比例。
//
// SynthDef 内部实际使用：
//
// dopplerMax1 = baseFreq1 * dopplerRatio
// dopplerMax2 = baseFreq2 * dopplerRatio
// dopplerMax3 = baseFreq3 * dopplerRatio
//
// 这里是 1 / 24 的十进制表示。
// SynthDef 参数默认值必须使用字面量。
~pnds[\dopplerRatio] = 0.0416666666667;


// FM 最大频率调制深度。
//
// 连接线强度为 1 时，每一对连接的调制深度为
// fmMax * 0.5。
// 一个声部最多同时受到另外两个声部的调制，
// 因此总调制深度约为 fmMax。
~pnds[\fmMax] = 300.0;


// 总音量
~pnds[\master] = 0.25;


// ------------------------------------------------------------
// SynthDef
// ------------------------------------------------------------
//
// 三个声部都是正弦波：
//
// voice 1：基础频率 500 Hz
// voice 2：基础频率 1000 Hz
// voice 3：基础频率 1500 Hz
//
// xN：声相
//      0.0 → 最左
//      0.5 → 中间
//      1.0 → 最右
//
// yN：音量
//      0.5 → 1.0
//      0.0 → 0.5
//      1.0 → 0.5
//
// couple12：voice 1 与 voice 2 之间的 FM 强度
// couple13：voice 1 与 voice 3 之间的 FM 强度
// couple23：voice 2 与 voice 3 之间的 FM 强度
//
// couple12、couple13、couple23 的范围都是 0...1。
//
// 这些值来自 server.js 中的 stroke：
//
// stroke = map(distance, 0, maxLineLength, 1, 0)
//
// 因此：
//
// 距离为 0                       → FM 强度最大
// 距离接近 maxLineLength         → FM 强度接近 0
// 距离超过 maxLineLength         → FM 关闭
// ------------------------------------------------------------

~pnds[\synthDef] = SynthDef(
    \inarticulateIII,
    {
        |
        out = 0,

        baseFreq1 = 500.0,
        baseFreq2 = 1000.0,
        baseFreq3 = 1500.0,

        gate1 = 0,
        gate2 = 0,
        gate3 = 0,

        x1 = 0.5,
        y1 = 0.5,

        x2 = 0.5,
        y2 = 0.5,

        x3 = 0.5,
        y3 = 0.5,

        couple12 = 0,
        couple13 = 0,
        couple23 = 0,

        positionLag = 0.12,
        couplingLag = 0.12,
        dopplerLag = 0.18,
        gateLag = 0.03,

        motionReferenceSpeed = 8.0,
        motionDeadzone = 0.04,

        dopplerRatio = 0.0416666666667,
        fmMax = 300.0,
        master = 0.25
        |

        var base1;
        var base2;
        var base3;

        var positionLagTime;
        var couplingLagTime;
        var dopplerLagTime;
        var gateLagTime;

        var referenceSpeed;
        var deadzone;
        var ratio;
        var fmMaximum;

        var gate1Smooth;
        var gate2Smooth;
        var gate3Smooth;

        var x1Smooth;
        var y1Smooth;

        var x2Smooth;
        var y2Smooth;

        var x3Smooth;
        var y3Smooth;

        var coupling12Smooth;
        var coupling13Smooth;
        var coupling23Smooth;

        var level1;
        var level2;
        var level3;

        var pan1;
        var pan2;
        var pan3;

        var velocityX1;
        var velocityY1;
        var velocityX2;
        var velocityY2;
        var velocityX3;
        var velocityY3;

        var rawSpeed1;
        var rawSpeed2;
        var rawSpeed3;

        var speed1;
        var speed2;
        var speed3;

        var dopplerMax1;
        var dopplerMax2;
        var dopplerMax3;

        var dopplerShift1;
        var dopplerShift2;
        var dopplerShift3;

        var pairDepth12;
        var pairDepth13;
        var pairDepth23;

        var feedback;
        var feedback1;
        var feedback2;
        var feedback3;

        var modulation1;
        var modulation2;
        var modulation3;

        var frequency1;
        var frequency2;
        var frequency3;

        var oscillator1;
        var oscillator2;
        var oscillator3;

        var signal1;
        var signal2;
        var signal3;

        var masterSmooth;
        var stereo;


        // ----------------------------------------------------
        // 基础频率
        // ----------------------------------------------------

        base1 = baseFreq1.clip(20, 20000);
        base2 = baseFreq2.clip(20, 20000);
        base3 = baseFreq3.clip(20, 20000);


        // ----------------------------------------------------
        // 参数限制
        // ----------------------------------------------------

        positionLagTime = positionLag.clip(0.005, 2.0);
        couplingLagTime = couplingLag.clip(0.005, 2.0);
        dopplerLagTime = dopplerLag.clip(0.005, 2.0);
        gateLagTime = gateLag.clip(0.005, 2.0);

        referenceSpeed = motionReferenceSpeed.clip(0.01, 100.0);
        deadzone = motionDeadzone.clip(0.0, 1.0);
        ratio = dopplerRatio.clip(0.0, 0.25);
        fmMaximum = fmMax.clip(0.0, 2000.0);


        // ----------------------------------------------------
        // Gate 平滑
        // ----------------------------------------------------

        gate1Smooth = Lag.kr(
            gate1.clip(0, 1),
            gateLagTime
        );

        gate2Smooth = Lag.kr(
            gate2.clip(0, 1),
            gateLagTime
        );

        gate3Smooth = Lag.kr(
            gate3.clip(0, 1),
            gateLagTime
        );


        // ----------------------------------------------------
        // x/y 平滑
        //
        // OSC 发送的是离散目标值。
        // 这里先将其转换为连续的 control-rate 信号。
        // ----------------------------------------------------

        x1Smooth = Lag.kr(
            x1.clip(0, 1),
            positionLagTime
        );

        y1Smooth = Lag.kr(
            y1.clip(0, 1),
            positionLagTime
        );


        x2Smooth = Lag.kr(
            x2.clip(0, 1),
            positionLagTime
        );

        y2Smooth = Lag.kr(
            y2.clip(0, 1),
            positionLagTime
        );


        x3Smooth = Lag.kr(
            x3.clip(0, 1),
            positionLagTime
        );

        y3Smooth = Lag.kr(
            y3.clip(0, 1),
            positionLagTime
        );


        // ----------------------------------------------------
        // 连接线强度平滑
        //
        // server.js 发出的 stroke 也是离散的 OSC 控制目标。
        // 因此不能直接将 couple12 当作最终调制信号，
        // 而要先通过 Lag.kr 平滑。
        // ----------------------------------------------------

        coupling12Smooth = Lag.kr(
            couple12.clip(0, 1),
            couplingLagTime
        );

        coupling13Smooth = Lag.kr(
            couple13.clip(0, 1),
            couplingLagTime
        );

        coupling23Smooth = Lag.kr(
            couple23.clip(0, 1),
            couplingLagTime
        );


        // ----------------------------------------------------
        // y → 音量
        //
        // y = 0.5 → 1.0
        // y = 0.0 → 0.5
        // y = 1.0 → 0.5
        // ----------------------------------------------------

        level1 = (
            1.0
            - (y1Smooth - 0.5).abs
        );

        level2 = (
            1.0
            - (y2Smooth - 0.5).abs
        );

        level3 = (
            1.0
            - (y3Smooth - 0.5).abs
        );


        // ----------------------------------------------------
        // x → 声相
        //
        // x = 0.0 → -1.0，最左
        // x = 0.5 →  0.0，中间
        // x = 1.0 →  1.0，最右
        // ----------------------------------------------------

        pan1 = x1Smooth.linlin(
            0,
            1,
            -1,
            1
        );

        pan2 = x2Smooth.linlin(
            0,
            1,
            -1,
            1
        );

        pan3 = x3Smooth.linlin(
            0,
            1,
            -1,
            1
        );


        // ----------------------------------------------------
        // 从平滑后的 x/y 计算速度
        // ----------------------------------------------------
        //
        // Slope.kr 输出每秒变化量。
        // 因为 x/y 已经经过 Lag.kr，
        // 这里计算的是平滑轨迹的速度，
        // 而不是原始 OSC 阶梯的瞬时跳变。
        // ----------------------------------------------------

        velocityX1 = Slope.kr(x1Smooth);
        velocityY1 = Slope.kr(y1Smooth);

        velocityX2 = Slope.kr(x2Smooth);
        velocityY2 = Slope.kr(y2Smooth);

        velocityX3 = Slope.kr(x3Smooth);
        velocityY3 = Slope.kr(y3Smooth);


        // ----------------------------------------------------
        // x/y 平面速度大小
        // ----------------------------------------------------

        rawSpeed1 = (
            (
                (velocityX1 * velocityX1)
                + (velocityY1 * velocityY1)
            ).sqrt
        );

        rawSpeed2 = (
            (
                (velocityX2 * velocityX2)
                + (velocityY2 * velocityY2)
            ).sqrt
        );

        rawSpeed3 = (
            (
                (velocityX3 * velocityX3)
                + (velocityY3 * velocityY3)
            ).sqrt
        );


        // ----------------------------------------------------
        // 速度归一化
        //
        // 先减去死区，再除以参考速度。
        // ----------------------------------------------------

        speed1 = (
            (rawSpeed1 - deadzone).max(0)
            / referenceSpeed
        ).clip(0, 1);

        speed2 = (
            (rawSpeed2 - deadzone).max(0)
            / referenceSpeed
        ).clip(0, 1);

        speed3 = (
            (rawSpeed3 - deadzone).max(0)
            / referenceSpeed
        ).clip(0, 1);


        // ----------------------------------------------------
        // 平方曲线
        //
        // 抑制小幅度移动造成的 Doppler。
        //
        // 0.2 → 0.04
        // 0.5 → 0.25
        // 1.0 → 1.00
        // ----------------------------------------------------

        speed1 = speed1 * speed1;
        speed2 = speed2 * speed2;
        speed3 = speed3 * speed3;


        // ----------------------------------------------------
        // 速度平滑
        // ----------------------------------------------------

        speed1 = Lag.kr(
            speed1,
            dopplerLagTime
        );

        speed2 = Lag.kr(
            speed2,
            dopplerLagTime
        );

        speed3 = Lag.kr(
            speed3,
            dopplerLagTime
        );


        // ----------------------------------------------------
        // Doppler 最大偏移
        //
        // 关键公式：
        //
        // dopplerMax1 = base1 * ratio
        // dopplerMax2 = base2 * ratio
        // dopplerMax3 = base3 * ratio
        //
        // 因此基础频率改变时，Doppler 最大偏移
        // 会自动随之改变。
        // ----------------------------------------------------

        dopplerMax1 = base1 * ratio;
        dopplerMax2 = base2 * ratio;
        dopplerMax3 = base3 * ratio;

        dopplerShift1 = speed1 * dopplerMax1;
        dopplerShift2 = speed2 * dopplerMax2;
        dopplerShift3 = speed3 * dopplerMax3;


        // ----------------------------------------------------
        // 连接线距离 → FM 调制深度
        //
        // 每个连接对的最大深度是 fmMaximum * 0.5。
        //
        // 例如 couple12 = 1：
        // voice 1 和 voice 2 之间使用完整的 pairDepth12。
        //
        // 一个声部最多同时受到两个其他声部影响，
        // 所以乘以 0.5 可以避免两组连接同时最大时
        // 调制深度简单叠加到两倍。
        // ----------------------------------------------------

        pairDepth12 = coupling12Smooth
            * fmMaximum
            * 0.5;

        pairDepth13 = coupling13Smooth
            * fmMaximum
            * 0.5;

        pairDepth23 = coupling23Smooth
            * fmMaximum
            * 0.5;


        // ----------------------------------------------------
        // 互相 FM 反馈
        // ----------------------------------------------------

        feedback = LocalIn.ar(3);

        feedback1 = feedback[0].clip(-1, 1);
        feedback2 = feedback[1].clip(-1, 1);
        feedback3 = feedback[2].clip(-1, 1);


        // voice 1 受到 voice 2 和 voice 3 的调制
        modulation1 = (
            feedback2 * pairDepth12
        ) + (
            feedback3 * pairDepth13
        );


        // voice 2 受到 voice 1 和 voice 3 的调制
        modulation2 = (
            feedback1 * pairDepth12
        ) + (
            feedback3 * pairDepth23
        );


        // voice 3 受到 voice 1 和 voice 2 的调制
        modulation3 = (
            feedback1 * pairDepth13
        ) + (
            feedback2 * pairDepth23
        );


        // ----------------------------------------------------
        // 固定基础频率
        // + Doppler
        // + 距离驱动的相互 FM
        // ----------------------------------------------------

        frequency1 = (
            base1
            + dopplerShift1
            + modulation1
        ).clip(20, 20000);

        frequency2 = (
            base2
            + dopplerShift2
            + modulation2
        ).clip(20, 20000);

        frequency3 = (
            base3
            + dopplerShift3
            + modulation3
        ).clip(20, 20000);


        // ----------------------------------------------------
        // 三个正弦波振荡器
        // ----------------------------------------------------

        oscillator1 = SinOsc.ar(frequency1);
        oscillator2 = SinOsc.ar(frequency2);
        oscillator3 = SinOsc.ar(frequency3);


        // ----------------------------------------------------
        // 写回反馈网络
        //
        // Gate 关闭时，该声部不再作为 FM 调制源。
        // ----------------------------------------------------

        LocalOut.ar([
            oscillator1 * gate1Smooth,
            oscillator2 * gate2Smooth,
            oscillator3 * gate3Smooth
        ]);


        // ----------------------------------------------------
        // 三个声部的实际输出
        // ----------------------------------------------------

        signal1 = oscillator1
            * gate1Smooth
            * level1;

        signal2 = oscillator2
            * gate2Smooth
            * level2;

        signal3 = oscillator3
            * gate3Smooth
            * level3;


        // ----------------------------------------------------
        // 总音量平滑
        // ----------------------------------------------------

        masterSmooth = Lag.kr(
            master.clip(0, 1),
            0.1
        );


        // ----------------------------------------------------
        // 立体声输出
        // ----------------------------------------------------

        stereo =
            Pan2.ar(signal1, pan1)
            + Pan2.ar(signal2, pan2)
            + Pan2.ar(signal3, pan3);


        // ----------------------------------------------------
        // 最终输出
        // ----------------------------------------------------

        Out.ar(
            out,
            Limiter.ar(
                stereo * masterSmooth,
                0.95
            )
        );
    }
);


// ------------------------------------------------------------
// 等待服务器启动
// ------------------------------------------------------------

s.waitForBoot {
    Routine({

        // ----------------------------------------------------
        // 将 SynthDef 发送到 scsynth
        // ----------------------------------------------------

        ~pnds[\synthDef].add;
        s.sync;


        // ----------------------------------------------------
        // 创建唯一的组合 Synth
        // ----------------------------------------------------

        ~pnds[\synth] = Synth(
            \inarticulateIII,
            [
                \out, 0,

                \baseFreq1,
                ~pnds[\baseFreq1],

                \baseFreq2,
                ~pnds[\baseFreq2],

                \baseFreq3,
                ~pnds[\baseFreq3],

                \positionLag,
                ~pnds[\positionLag],

                \couplingLag,
                ~pnds[\couplingLag],

                \dopplerLag,
                ~pnds[\dopplerLag],

                \gateLag,
                ~pnds[\gateLag],

                \motionReferenceSpeed,
                ~pnds[\motionReferenceSpeed],

                \motionDeadzone,
                ~pnds[\motionDeadzone],

                \dopplerRatio,
                ~pnds[\dopplerRatio],

                \fmMax,
                ~pnds[\fmMax],

                \master,
                ~pnds[\master]
            ]
        );

        s.sync;


        // ----------------------------------------------------
        // Gate 控制
        // ----------------------------------------------------

        ~pnds[\setGate] = { |player, value|
            var controls;
            var index;
            var gateValue;

            controls = [
                \gate1,
                \gate2,
                \gate3
            ];

            index = player.asInteger - 1;

            gateValue = ~pnds[\unit].value(
                value,
                0.0
            );

            if(
                index >= 0 and: {
                    index < controls.size
                }
            ) {
                ~pnds[\synth].set(
                    controls[index],
                    gateValue
                );
            };
        };


        // ----------------------------------------------------
        // 设置 x/y
        //
        // 第四个参数 ignoredAmp 只是为了兼容当前
        // server.js 发出的 /pNxy x y amp 协议。
        //
        // amp 不再参与声音控制。
        // ----------------------------------------------------

        ~pnds[\setPlayerXY] = {
            |player, x, y, ignoredAmp|

            var controls;
            var index;

            var xValue;
            var yValue;

            controls = [
                [\x1, \y1],
                [\x2, \y2],
                [\x3, \y3]
            ];

            index = player.asInteger - 1;

            if(
                index >= 0 and: {
                    index < controls.size
                }
            ) {
                xValue = ~pnds[\unit].value(
                    x,
                    0.5
                );

                yValue = ~pnds[\unit].value(
                    y,
                    0.5
                );

                ~pnds[\synth].set(
                    controls[index][0],
                    xValue,

                    controls[index][1],
                    yValue
                );
            };
        };


        // ----------------------------------------------------
        // 设置一组连接的 FM 强度
        // ----------------------------------------------------

        ~pnds[\setCoupling] = {
            |control, value|

            var valueClipped;

            valueClipped = ~pnds[\unit].value(
                value,
                0.0
            );

            if(control.notNil) {
                ~pnds[\synth].set(
                    control,
                    valueClipped
                );
            };
        };


        // ----------------------------------------------------
        // OSCdef 列表
        // ----------------------------------------------------

        ~pnds[\oscdefs] = List.new;


        // ----------------------------------------------------
        // Player 1
        // ----------------------------------------------------

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_gate_1,
                { |message|
                    ~pnds[\setGate].value(
                        1,
                        message[1]
                    );
                },
                '/p1'
            )
        );

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_xy_1,
                { |message|
                    ~pnds[\setPlayerXY].value(
                        1,
                        message[1],
                        message[2],
                        message[3]
                    );
                },
                '/p1xy'
            )
        );


        // ----------------------------------------------------
        // Player 2
        // ----------------------------------------------------

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_gate_2,
                { |message|
                    ~pnds[\setGate].value(
                        2,
                        message[1]
                    );
                },
                '/p2'
            )
        );

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_xy_2,
                { |message|
                    ~pnds[\setPlayerXY].value(
                        2,
                        message[1],
                        message[2],
                        message[3]
                    );
                },
                '/p2xy'
            )
        );


        // ----------------------------------------------------
        // Player 3
        // ----------------------------------------------------

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_gate_3,
                { |message|
                    ~pnds[\setGate].value(
                        3,
                        message[1]
                    );
                },
                '/p3'
            )
        );

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_xy_3,
                { |message|
                    ~pnds[\setPlayerXY].value(
                        3,
                        message[1],
                        message[2],
                        message[3]
                    );
                },
                '/p3xy'
            )
        );


        // ----------------------------------------------------
        // Player 1 ↔ Player 2
        //
        // 当前 server.js 可能发送：
        //
        // /p1-p2 value
        // /p2-p1 value
        //
        // 两个方向都映射到 couple12。
        // ----------------------------------------------------

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_line_12,
                { |message|
                    ~pnds[\setCoupling].value(
                        \couple12,
                        message[1]
                    );
                },
                '/p1-p2'
            )
        );

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_line_21,
                { |message|
                    ~pnds[\setCoupling].value(
                        \couple12,
                        message[1]
                    );
                },
                '/p2-p1'
            )
        );


        // ----------------------------------------------------
        // Player 1 ↔ Player 3
        // ----------------------------------------------------

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_line_13,
                { |message|
                    ~pnds[\setCoupling].value(
                        \couple13,
                        message[1]
                    );
                },
                '/p1-p3'
            )
        );

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_line_31,
                { |message|
                    ~pnds[\setCoupling].value(
                        \couple13,
                        message[1]
                    );
                },
                '/p3-p1'
            )
        );


        // ----------------------------------------------------
        // Player 2 ↔ Player 3
        // ----------------------------------------------------

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_line_23,
                { |message|
                    ~pnds[\setCoupling].value(
                        \couple23,
                        message[1]
                    );
                },
                '/p2-p3'
            )
        );

        ~pnds[\oscdefs].add(
            OSCdef(
                \pnds_line_32,
                { |message|
                    ~pnds[\setCoupling].value(
                        \couple23,
                        message[1]
                    );
                },
                '/p3-p2'
            )
        );


        // ----------------------------------------------------
        // 手动调试：全部开启
        // ----------------------------------------------------

        ~pnds[\allOn] = {
            ~pnds[\setGate].value(1, 1);
            ~pnds[\setGate].value(2, 1);
            ~pnds[\setGate].value(3, 1);

            ~pnds[\setPlayerXY].value(
                1,
                0.0,
                0.5,
                0.0
            );

            ~pnds[\setPlayerXY].value(
                2,
                0.5,
                0.5,
                0.0
            );

            ~pnds[\setPlayerXY].value(
                3,
                1.0,
                0.5,
                0.0
            );

            ~pnds[\setCoupling].value(
                \couple12,
                0.0
            );

            ~pnds[\setCoupling].value(
                \couple13,
                0.0
            );

            ~pnds[\setCoupling].value(
                \couple23,
                0.0
            );
        };


        // ----------------------------------------------------
        // 手动调试：全部关闭
        // ------------------------------------------------------------

        ~pnds[\allOff] = {
            ~pnds[\setGate].value(1, 0);
            ~pnds[\setGate].value(2, 0);
            ~pnds[\setGate].value(3, 0);

            ~pnds[\setCoupling].value(
                \couple12,
                0.0
            );

            ~pnds[\setCoupling].value(
                \couple13,
                0.0
            );

            ~pnds[\setCoupling].value(
                \couple23,
                0.0
            );
        };


        // ----------------------------------------------------
        // 手动测试连接线 FM
        // ------------------------------------------------------------

        ~pnds[\testLines] = {
            ~pnds[\setGate].value(1, 1);
            ~pnds[\setGate].value(2, 1);
            ~pnds[\setGate].value(3, 1);

            ~pnds[\setPlayerXY].value(
                1,
                0.2,
                0.5,
                0.0
            );

            ~pnds[\setPlayerXY].value(
                2,
                0.5,
                0.5,
                0.0
            );

            ~pnds[\setPlayerXY].value(
                3,
                0.8,
                0.5,
                0.0
            );

            ~pnds[\setCoupling].value(
                \couple12,
                0.8
            );

            ~pnds[\setCoupling].value(
                \couple13,
                0.4
            );

            ~pnds[\setCoupling].value(
                \couple23,
                0.6
            );
        };


        // ----------------------------------------------------
        // 调整总音量
        // ------------------------------------------------------------

        ~pnds[\setMaster] = { |value = 0.25|
            ~pnds[\synth].set(
                \master,
                value.asFloat.clip(0, 1)
            );
        };


        // ----------------------------------------------------
        // 调整 FM 最大深度
        // ------------------------------------------------------------

        ~pnds[\setFMMax] = { |value = 300|
            ~pnds[\synth].set(
                \fmMax,
                value.asFloat.clip(0, 2000)
            );
        };


        // ----------------------------------------------------
        // 调整连接线强度平滑时间
        // ------------------------------------------------------------

        ~pnds[\setCouplingSmoothing] = { |value = 0.12|
            ~pnds[\synth].set(
                \couplingLag,
                value.asFloat.clip(0.005, 2.0)
            );
        };


        // ----------------------------------------------------
        // 调整 x/y 平滑时间
        // ------------------------------------------------------------

        ~pnds[\setPositionSmoothing] = { |value = 0.12|
            ~pnds[\synth].set(
                \positionLag,
                value.asFloat.clip(0.005, 2.0)
            );
        };


        // ----------------------------------------------------
        // 调整 Doppler 比例
        //
        // 默认值为 1/24。
        // 这里使用字面量，避免 SynthDef 参数语法错误。
        // ------------------------------------------------------------

        ~pnds[\setDopplerRatio] = { |value = 0.0416666666667|
            ~pnds[\synth].set(
                \dopplerRatio,
                value.asFloat.clip(0, 0.25)
            );
        };


        // ----------------------------------------------------
        // 调整运动参考速度
        // ------------------------------------------------------------

        ~pnds[\setMotionReferenceSpeed] = { |value = 8.0|
            ~pnds[\synth].set(
                \motionReferenceSpeed,
                value.asFloat.clip(0.01, 100.0)
            );
        };


        // ----------------------------------------------------
        // 调整运动死区
        // ------------------------------------------------------------

        ~pnds[\setMotionDeadzone] = { |value = 0.04|
            ~pnds[\synth].set(
                \motionDeadzone,
                value.asFloat.clip(0.0, 1.0)
            );
        };


        // ----------------------------------------------------
        // 清理函数
        // ------------------------------------------------------------

        ~pnds[\cleanup] = {
            if(~pnds[\oscdefs].notNil) {
                ~pnds[\oscdefs].do { |definition|
                    definition.free;
                };

                ~pnds[\oscdefs] = nil;
            };

            if(~pnds[\synth].notNil) {
                ~pnds[\synth].free;
                ~pnds[\synth] = nil;
            };

            "PNDS Inarticulate III: cleaned up.".postln;
        };


        // ----------------------------------------------------
        // 启动信息
        // ------------------------------------------------------------

        "--------------------------------------------------".postln;
        "Inarticulate III SuperCollider bridge ready.".postln;

        (
            "SuperCollider language OSC port: "
            ++ NetAddr.langPort
        ).postln;

        (
            "scsynth server port: "
            ++ s.addr.port
        ).postln;

        (
            "Synth node ID: "
            ++ ~pnds[\synth].nodeID
        ).postln;

        "Carrier frequencies: baseFreq1 / baseFreq2 / baseFreq3".postln;
        "x: pan, y: level".postln;
        "pNamp: ignored".postln;
        "line stroke: pairwise FM coupling".postln;
        "Doppler max = baseFreq * dopplerRatio".postln;

        (
            "Doppler ratio: "
            ++ ~pnds[\dopplerRatio]
        ).postln;

        (
            "Coupling smoothing: "
            ++ ~pnds[\couplingLag]
        ).postln;

        "Expected Node.js target: 127.0.0.1:57120".postln;
        "--------------------------------------------------".postln;

    }).play(AppClock);
};


// ------------------------------------------------------------
// 如果服务器尚未运行，则自动启动
// ------------------------------------------------------------

if(s.serverRunning.not) {
    s.boot;
};
)