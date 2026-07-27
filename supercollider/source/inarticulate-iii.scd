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
