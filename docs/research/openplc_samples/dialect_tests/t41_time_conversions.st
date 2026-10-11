PROGRAM main
  VAR t1 : TON; ms : DINT; pt : TIME := T#3s; i : INT; END_VAR
  t1(IN := TRUE, PT := pt);
  ms := TIME_TO_DINT(t1.ET);
  i := DINT_TO_INT(ms / 1000);
  pt := DINT_TO_TIME(5000);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
