PROGRAM main
  VAR
    in1 : BOOL; in2 : BOOL; q1 : BOOL; q2 : BOOL; q3 : BOOL; q4 : BOOL; q5 : BOOL; q6 : BOOL;
    i1 : INT := 7; i2 : INT := 3; i3 : INT; r1 : REAL; d1 : DINT; w1 : WORD; t1 : TIME;
    tof1 : TOF; tp1 : TP; ton1 : TON; ft1 : F_TRIG; rt1 : R_TRIG; sr1 : SR; rs1 : RS;
    ctu1 : CTU; ctd1 : CTD; ctud1 : CTUD;
  END_VAR
  tof1(IN := in1, PT := T#2s);
  tp1(IN := in1, PT := T#500ms);
  ton1(IN := in2, PT := TIME#1m30s);
  ft1(CLK := in1);
  rt1(CLK := in2);
  sr1(S1 := in1, R := in2);
  rs1(S := in1, R1 := in2);
  ctu1(CU := rt1.Q, R := ft1.Q, PV := 10);
  ctd1(CD := rt1.Q, LD := ft1.Q, PV := 10);
  ctud1(CU := rt1.Q, CD := ft1.Q, R := FALSE, LD := FALSE, PV := 5);
  q1 := tof1.Q; q2 := tp1.Q; q3 := sr1.Q1; q4 := rs1.Q1; q5 := ctu1.Q; q6 := ctud1.QU;
  i3 := MAX(i1, i2) + MIN(i1, i2) + LIMIT(0, i1, 5) + ABS(-3) + SEL(in1, i1, i2) + MUX(1, i1, i2);
  r1 := INT_TO_REAL(i3) * 1.5 + SQRT(16.0);
  d1 := INT_TO_DINT(i3) * 1000;
  w1 := SHL(INT_TO_WORD(i1), 2) AND 16#FF;
  t1 := ton1.ET + T#100ms;
  IF ton1.ET > T#2s THEN q1 := TRUE; END_IF;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
