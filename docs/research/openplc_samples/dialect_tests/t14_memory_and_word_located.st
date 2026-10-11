PROGRAM main
  VAR
    m0 AT %MW0 : INT;
    md0 AT %MD0 : DINT;
    iw AT %IW100 : INT;
    qw AT %QW100 : INT;
    ib AT %IB0 : BYTE;
  END_VAR
  m0 := iw + 1;
  md0 := INT_TO_DINT(m0);
  qw := m0;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
