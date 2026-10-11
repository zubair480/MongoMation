PROGRAM fast
  VAR a : BOOL; END_VAR
  a := NOT a;
END_PROGRAM
PROGRAM slow
  VAR b : INT; END_VAR
  b := b + 1;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK fast_task(INTERVAL := T#10ms,PRIORITY := 0);
    TASK slow_task(INTERVAL := T#100ms,PRIORITY := 1);
    PROGRAM inst_fast WITH fast_task : fast;
    PROGRAM inst_slow WITH slow_task : slow;
  END_RESOURCE
END_CONFIGURATION
